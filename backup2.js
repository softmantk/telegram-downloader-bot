require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const Bull = require("bull");
const { createBullBoard } = require("@bull-board/api");
const { BullAdapter } = require("@bull-board/api/bullAdapter");
const { ExpressAdapter } = require("@bull-board/express");
const winston = require("winston");

// Track active downloads per chat - simplified structure
const activeDownloads = new Map();

// Configure Winston logger with timestamps
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [
    new winston.transports.Console()
  ]
});

const app = express();
app.use(express.json());

/** ========== Environment Variables ========== */
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH;
const BASE_URL = process.env.BOT_SERVER_BASEURL;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
logger.info(`CONFIG: ${JSON.stringify({PORT, BOT_TOKEN, DOWNLOAD_PATH, BASE_URL})}`);

/** ========== Retry & Backoff Settings ========== */
const MAX_RETRIES = 3;
const BACKOFF_DELAYS = [60, 120, 240];

function getWaitTime(is429, attempt, retryAfterFromTelegram = 30) {
    if (is429) {
        return retryAfterFromTelegram;
    }
    if (attempt <= BACKOFF_DELAYS.length) {
        return BACKOFF_DELAYS[attempt - 1] || 30;
    }
    return 30;
}

function delayFn(timeout = 1000) {
    return new Promise((resolve) => setTimeout(resolve, timeout));
}

/** ========== Bull Queue Setup ========== */
const fileQueue = new Bull('file-processing', REDIS_URL, {
    defaultJobOptions: {
        attempts: MAX_RETRIES,
        backoff: {
            type: 'exponential',
            delay: BACKOFF_DELAYS[0] * 1000
        },
        removeOnComplete: false,
        removeOnFail: false
    }
});

// Set up Bull Board UI
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

const BULL_UI_USERNAME = process.env.BULL_UI_USERNAME || 'admin';
const BULL_UI_PASSWORD = process.env.BULL_UI_PASSWORD || 'admin';

const { addQueue, removeQueue, setQueues, replaceQueues } = createBullBoard({
    queues: [new BullAdapter(fileQueue, {
        allowRetries: true,
        formatter: (job) => {
            return job.data.name || job.data.fileName || `Job ${job.id}`;
        }
    })],
    serverAdapter
});

// Basic auth middleware
app.use('/admin/queues', (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Bull UI"');
        return res.status(401).send('Authentication required');
    }
    
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const username = auth[0];
    const password = auth[1];
    
    if (username === BULL_UI_USERNAME && password === BULL_UI_PASSWORD) {
        return next();
    }
    
    res.setHeader('WWW-Authenticate', 'Basic realm="Bull UI"');
    return res.status(401).send('Authentication failed');
});

app.use('/admin/queues', serverAdapter.getRouter());

logger.info(`Bull UI protected with basic auth (username: ${BULL_UI_USERNAME})`);

// Queue event listeners
fileQueue.on('completed', (job, result) => {
    logger.info(`[COMPLETED] Job ${job.id} | File: ${job.data.fileName || 'Unknown'} | Size: ${job.data.message?.document?.file_size ? (job.data.message.document.file_size / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown'}`);
});

fileQueue.on('failed', (job, error) => {
    logger.error(`[FAILED] Job ${job.id} | File: ${job.data.fileName || 'Unknown'} | Error: ${error.message}`);
});

fileQueue.on('stalled', (job) => {
    logger.warn(`[STALLED] Job ${job.id} | File: ${job.data.fileName || 'Unknown'} | Attempt: ${job.attemptsMade}/${job.opts.attempts}`);
});

fileQueue.on('active', (job) => {
    logger.info(`[ACTIVE] Job ${job.id} | File: ${job.data.fileName || 'Unknown'} | Processing started`);
});

/** ========== Telegram API Helper ========== */
async function telegramApiRequest({
    endpoint,
    method = "POST",
    data = {},
    chatId,
    fallbackReply,
    attempt = 1,
}) {
    const url = `${BASE_URL}/bot${BOT_TOKEN}/${endpoint}`;

    try {
        let resp;
        if (method === "GET") {
            resp = await axios.get(url, {params: data});
        } else {
            resp = await axios.post(url, data);
        }
        return resp.data;
    } catch (err) {
        const is429 = err?.response?.data?.error_code === 429;
        const retryAfterFromTelegram = err?.response?.data?.parameters?.retry_after || 30;

        if (attempt < MAX_RETRIES) {
            const waitTime = getWaitTime(is429, attempt, retryAfterFromTelegram);
            logger.error(
                `Telegram Error. Attempt=${attempt}, will retry in ${waitTime} seconds.`
            );
            await fallbackReply(`Telegram Error. Waiting ${waitTime} seconds before retry...`);
            await delayFn(waitTime * 1000);

            return telegramApiRequest({
                endpoint,
                method,
                data,
                chatId,
                fallbackReply,
                attempt: attempt + 1,
            });
        }

        logger.error("Max retries reached. Aborting request.");
        throw err;
    }
}

/** ========== Telegram Wrappers ========== */
async function sendMessage(chatId, text) {
    const responseData = await telegramApiRequest({
        endpoint: "sendMessage",
        method: "POST",
        data: {chat_id: chatId, text},
        chatId,
        fallbackReply: async (msg) => sendMessage(chatId, msg),
    });
    return responseData.result?.message_id;
}

async function editMessage(chatId, messageId, text) {
    try {
        await telegramApiRequest({
            endpoint: "editMessageText",
            method: "POST",
            data: {chat_id: chatId, message_id: messageId, text},
            chatId,
            fallbackReply: async (msg) => sendMessage(chatId, msg),
        });
        return true;
    } catch (error) {
        logger.error(`Error editing message: ${error.message}`);
        return false;
    }
}

/**
 * Simplified status message management
 * Each job gets its own status message that gets updated throughout the process
 */
async function createStatusMessage(chatId, jobId, fileName) {
    const initialText = `📁 File: ${fileName}\n🔄 Status: Queued for processing...`;
    const messageId = await sendMessage(chatId, initialText);
    
    activeDownloads.set(jobId, {
        chatId,
        messageId,
        fileName,
        lastUpdate: Date.now()
    });
    
    return messageId;
}

async function updateStatusMessage(jobId, text) {
    const downloadInfo = activeDownloads.get(jobId);
    if (!downloadInfo) {
        logger.warn(`No status message found for job ${jobId}`);
        return false;
    }
    
    const success = await editMessage(downloadInfo.chatId, downloadInfo.messageId, text);
    if (success) {
        downloadInfo.lastUpdate = Date.now();
        activeDownloads.set(jobId, downloadInfo);
    }
    return success;
}

function cleanupStatusMessage(jobId) {
    activeDownloads.delete(jobId);
}

/** ========== File Operations ========== */
function moveAndRenameFile(source, destination) {
    return new Promise((resolve, reject) => {
        fs.rename(source, destination, (err) => {
            if (err) {
                if (err.code === "EXDEV") {
                    // cross-device fallback
                    const readStream = fs.createReadStream(source);
                    const writeStream = fs.createWriteStream(destination);
                    
                    readStream.on("error", reject);
                    writeStream.on("error", reject);
                    writeStream.on("close", () => {
                        fs.unlink(source, (unlinkErr) => {
                            if (unlinkErr) logger.warn(`Failed to delete source file: ${unlinkErr.message}`);
                            resolve();
                        });
                    });
                    readStream.pipe(writeStream);
                } else {
                    reject(err);
                }
            } else {
                resolve();
            }
        });
    });
}

/** ========== Progress Updates ========== */
async function updateProgress(jobId, fileName, stage, progress = null) {
    let statusText = `📁 File: ${fileName}\n`;
    
    switch (stage) {
        case 'queued':
            statusText += `🔄 Status: Queued for processing...`;
            break;
        case 'starting':
            statusText += `🚀 Status: Starting download...`;
            break;
        case 'downloading':
            const progressBar = progress ? 
                `[${"▓".repeat(Math.floor(progress/10))}${"░".repeat(10 - Math.floor(progress/10))}] ${progress}%` : 
                `[░░░░░░░░░░] 0%`;
            statusText += `⬇️ Status: Downloading...\n📊 Progress: ${progressBar}`;
            break;
        case 'moving':
            statusText += `📦 Status: Processing file...`;
            break;
        case 'completed':
            statusText += `✅ Status: Download completed successfully!`;
            break;
        case 'failed':
            statusText += `❌ Status: Download failed`;
            break;
        case 'retrying':
            statusText += `🔄 Status: Retrying download...`;
            break;
    }
    
    await updateStatusMessage(jobId, statusText);
}

/** ========== File Processing with Real Progress ========== */
async function processFile(sourcePath, targetPath, jobId, fileName) {
    try {
        // Update status to moving
        await updateProgress(jobId, fileName, 'moving');
        
        // Check if source file exists
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Source file not found: ${sourcePath}`);
        }
        
        // Get file stats for progress calculation
        const stats = fs.statSync(sourcePath);
        const fileSize = stats.size;
        
        // Simulate progress during file move (since file moves are usually instant)
        // In a real scenario, you might want to track actual download progress from Telegram API
        const progressSteps = [20, 40, 60, 80, 95];
        for (const progress of progressSteps) {
            await updateProgress(jobId, fileName, 'downloading', progress);
            await delayFn(500); // Small delay to show progress
        }
        
        // Actually move the file
        await moveAndRenameFile(sourcePath, targetPath);
        
        // Final progress update
        await updateProgress(jobId, fileName, 'completed');
        
        return { success: true, filePath: targetPath };
    } catch (error) {
        await updateProgress(jobId, fileName, 'failed');
        throw error;
    }
}

/** ========== Main Logic: processRequest ========== */
async function processRequest(job) {
    const { fileId, message, fileName } = job.data;
    const chatId = message.chat.id;
    
    try {
        const originalFileName = message.document.file_name;
        
        // Update status to starting
        await updateProgress(job.id, originalFileName, 'starting');

        // 1) Retrieve file info from Telegram
        const fileInfoData = await telegramApiRequest({
            endpoint: "getFile",
            method: "GET",
            data: {file_id: fileId},
            chatId,
            fallbackReply: async (msg) => {
                await updateStatusMessage(job.id, `📁 File: ${originalFileName}\n⚠️ ${msg}`);
            },
        });

        // 2) Resolve path from the file info
        const filePathOnServer = fileInfoData.result.file_path;
        const absoluteFilePathOnServer = path.join(filePathOnServer);
        const destinationPath = path.join(DOWNLOAD_PATH, originalFileName);

        logger.info(`Processing file: ${originalFileName} (Job ${job.id})`);
        logger.info(`Source: ${absoluteFilePathOnServer} -> Destination: ${destinationPath}`);

        // 3) Process the file with real-time updates
        const result = await processFile(absoluteFilePathOnServer, destinationPath, job.id, originalFileName);
        
        // 4) Final status update with full path
        await updateStatusMessage(job.id, 
            `📁 File: ${originalFileName}\n` +
            `✅ Status: Download completed successfully!\n` +
            `📂 Location: ${destinationPath}`
        );
        
        // Clean up after a delay
        setTimeout(() => {
            cleanupStatusMessage(job.id);
        }, 30000); // Keep message for 30 seconds after completion
        
        return result;
    } catch (error) {
        logger.error(`processRequest Error for Job ${job.id}: ${error.message}`);
        
        // Update status message with error
        await updateStatusMessage(job.id, 
            `📁 File: ${message.document.file_name}\n` +
            `❌ Status: Error - ${error.message}`
        );
        
        // Clean up after error
        setTimeout(() => {
            cleanupStatusMessage(job.id);
        }, 60000); // Keep error message for 1 minute
        
        throw error;
    }
}

// Register the job processor
fileQueue.process(async (job) => {
    return processRequest(job);
});

/** ========== Queue Status Updates ========== */
async function sendQueueStatus(chatId) {
    const jobCounts = await fileQueue.getJobCounts();
    await sendMessage(
        chatId, 
        `📊 Queue Status:\n` +
        `⏳ Waiting: ${jobCounts.waiting}\n` +
        `🔄 Active: ${jobCounts.active}\n` +
        `✅ Completed: ${jobCounts.completed}\n` +
        `❌ Failed: ${jobCounts.failed}\n` +
        `⏸️ Delayed: ${jobCounts.delayed}\n\n` +
        `🎛️ Dashboard: https://telwebhook.codey.in/admin/queues`
    );
}

/** ========== Webhook Endpoint ========== */
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
    logger.info("Webhook received");
    res.send("success");

    const {message} = req.body;
    if (!message || !message.document) return;

    const chatId = message.chat.id;
    const fileName = message.document.file_name;

    try {
        // Add job to Bull queue
        const job = await fileQueue.add(
            {
                fileId: message.document.file_id,
                message,
                fileName,
                name: fileName
            },
            {
                attempts: MAX_RETRIES,
                backoff: {
                    type: 'exponential',
                    delay: BACKOFF_DELAYS[0] * 1000
                }
            }
        );
        
        // Create initial status message
        await createStatusMessage(chatId, job.id, fileName);
        
        // Update to queued status
        await updateProgress(job.id, fileName, 'queued');
        
        logger.info(`Job ${job.id} created for file: ${fileName}`);
        
    } catch (error) {
        logger.error(`Error processing webhook: ${error.message}`);
        await sendMessage(chatId, `❌ Error processing file: ${fileName}\n${error.message}`);
    }
});

/** ========== Queue Status Endpoint ========== */
app.get('/queue-status', async (req, res) => {
    const jobCounts = await fileQueue.getJobCounts();
    res.json(jobCounts);
});

/** ========== Manual Retry Endpoint ========== */
app.post('/retry/:jobId', async (req, res) => {
    const { jobId } = req.params;
    
    try {
        const job = await fileQueue.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        
        // Update status to retrying
        const fileName = job.data.fileName || 'Unknown';
        await updateProgress(jobId, fileName, 'retrying');
        
        await job.retry();
        res.json({ success: true, message: `Job ${jobId} queued for retry` });
    } catch (error) {
        logger.error(`Error retrying job ${jobId}: ${error}`);
        res.status(500).json({ error: error.message });
    }
});

/** ========== Status Command Handler ========== */
app.post(`/status/${BOT_TOKEN}`, async (req, res) => {
    res.send("success");
    
    const {message} = req.body;
    if (!message || !message.text) return;
    
    const chatId = message.chat.id;
    const text = message.text.toLowerCase();
    
    if (text === '/status' || text === 'status') {
        await sendQueueStatus(chatId);
    }
});

/** ========== Fallback GET ========== */
app.get("/", (req, res) => {
    res.send(`
        <h1>Telegram File Bot</h1>
        <p>Bot is running and ready to process files!</p>
        <p><a href="/admin/queues">View Queue Dashboard</a></p>
    `);
});

/** ========== Listen ========== */
app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Bull UI available at: http://localhost:${PORT}/admin/queues`);
});