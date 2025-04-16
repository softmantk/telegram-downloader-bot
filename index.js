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
const MAX_RETRIES = 3; // maximum attempts
const BACKOFF_DELAYS = [60, 120, 240]; // seconds: 1min, 2min, 4min (exponential style)

/**
 * Helper to get wait time for next retry:
 * - If error is 429, we respect Telegram's retry_after.
 * - Otherwise, use exponential backoff from BACKOFF_DELAYS.
 */
function getWaitTime(is429, attempt, retryAfterFromTelegram = 30) {
    if (is429) {
        return retryAfterFromTelegram;
    }
    // For non-429 errors, fallback to an exponential pattern
    if (attempt <= BACKOFF_DELAYS.length) {
        return BACKOFF_DELAYS[attempt - 1] || 30;
    }
    // If attempt somehow exceeds known delays, fallback to 30s
    return 30;
}

function delayFn(timeout = 1000) {
    return new Promise((resolve) => setTimeout(resolve, timeout));
}

/** ========== Bull Queue Setup ========== */
// Create the file processing queue
const fileQueue = new Bull('file-processing', REDIS_URL, {
    defaultJobOptions: {
        attempts: MAX_RETRIES,
        backoff: {
            type: 'exponential',
            delay: BACKOFF_DELAYS[0] * 1000 // Use the same backoff delays as the original code
        },
        removeOnComplete: false, // Keep completed jobs in the queue
        removeOnFail: false // Keep failed jobs in the queue
    }
});

// Set up Bull Board UI with basic auth
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

// Add basic authentication
const BULL_UI_USERNAME = process.env.BULL_UI_USERNAME || 'admin';
const BULL_UI_PASSWORD = process.env.BULL_UI_PASSWORD || 'admin';

// Create the Bull Board with custom options to display file names
const { addQueue, removeQueue, setQueues, replaceQueues } = createBullBoard({
    queues: [new BullAdapter(fileQueue, {
        allowRetries: true,
        formatter: (job) => {
            // Use the file name from job data for display in UI
            return job.data.name || job.data.fileName || `Job ${job.id}`;
        }
    })],
    serverAdapter
});

// Add basic authentication middleware
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

// Mount the Bull UI router
app.use('/admin/queues', serverAdapter.getRouter());

logger.info(`Bull UI protected with basic auth (username: ${BULL_UI_USERNAME})`);

// Queue event listeners for logging with detailed file information
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

fileQueue.on('progress', (job, progress) => {
    logger.info(`[PROGRESS] Job ${job.id} | File: ${job.data.fileName || 'Unknown'} | ${progress}% complete`);
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

        // For any Telegram error, we handle up to MAX_RETRIES with either 429-based or exponential backoff
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

        // If we reached here, we've hit max attempts
        logger.error("Max retries reached. Aborting request.");
        throw err; // Let the caller handle the final error
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
    await telegramApiRequest({
        endpoint: "editMessageText",
        method: "POST",
        data: {chat_id: chatId, message_id: messageId, text},
        chatId,
        fallbackReply: async (msg) => sendMessage(chatId, msg),
    });
}

/** ========== File Operations ========== */
function moveAndRenameFile(source, destination, callback) {
    fs.rename(source, destination, (err) => {
        if (err) {
            if (err.code === "EXDEV") {
                // cross-device fallback
                const readStream = fs.createReadStream(source);
                const writeStream = fs.createWriteStream(destination);
                readStream.on("error", callback);
                writeStream.on("error", callback);
                readStream.on("close", () => fs.unlink(source, callback));
                readStream.pipe(writeStream);
            } else {
                callback(err);
            }
        } else {
            callback(null);
        }
    });
}

/** ========== Progress Simulation ========== */
async function sendProgress(chatId, messageId, steps = 10, duration = 3000, job) {
    const interval = duration / steps;
    let lastPercentage = 0;

    for (let i = 1; i <= steps; i++) {
        await delayFn(interval);
        const percentage = i * (100 / steps);
        
        // Update job progress in Bull
        if (job) {
            await job.progress(percentage);
        }
        
        if (percentage !== lastPercentage) {
            const progressBar = `[${"▓".repeat(i)}${"░".repeat(steps - i)}] ${percentage}%`;
            await editMessage(chatId, messageId, `Progress: ${progressBar}`);
            lastPercentage = percentage;
        }
    }
}

/** ========== File Processing ========== */
async function processFile(sourcePath, targetPath, chatId, reply, job) {
    // 1. Send initial message
    const msgId = await reply("Starting file move...");

    // 2. Send a fake progress bar
    await sendProgress(chatId, msgId, 10, 3000, job);

    // 3. Actually move the file
    return new Promise((resolve, reject) => {
        moveAndRenameFile(sourcePath, targetPath, async (err) => {
            if (err) {
                logger.error(`Error moving file: ${err}`);
                await editMessage(chatId, msgId, `Error: ${err.message}`);
                return reject(err);
            }
            await editMessage(chatId, msgId, `File successfully moved to ${targetPath}`);
            resolve();
        });
    });
}

/** ========== Main Logic: processRequest ========== */
async function processRequest(job) {
    const { fileId, message } = job.data;
    const chatId = message.chat.id;
    const reply = async (text) => sendMessage(chatId, text);
    
    try {
        const {file_name: originalFileName} = message.document;

        // 1) Retrieve file info from Telegram (GET) with backoff
        const fileInfoData = await telegramApiRequest({
            endpoint: "getFile",
            method: "GET",
            data: {file_id: fileId},
            chatId,
            fallbackReply: async (msg) => sendMessage(chatId, msg),
        });

        // 2) Resolve path from the file info
        const filePathOnServer = fileInfoData.result.file_path;
        const absoluteFilePathOnServer = path.join(filePathOnServer);

        const destinationPath = path.join(DOWNLOAD_PATH, originalFileName);

        logger.info(`File Info: ${JSON.stringify({
            originalFileName,
            fileId,
            filePathOnServer: absoluteFilePathOnServer,
            destinationPath,
        })}`);

        // 3) Show user we are about to move file
        await reply(`${originalFileName}\nPreparing to move file...`);

        // 4) Process the file (move + progress)
        await processFile(absoluteFilePathOnServer, destinationPath, chatId, reply, job);

        // 5) Notify success
        await reply(`${originalFileName} has been moved to ${destinationPath}`);
        
        return { success: true, filePath: destinationPath };
    } catch (error) {
        logger.error(`processRequest Error: ${error.response?.data || error.message}`);
        await reply(`Error: ${error.message} \nFILE: ${message.document.file_name}`);
        throw error; // Rethrow to let Bull handle the retry
    }
}

// Register the job processor for the default job type
fileQueue.process(async (job) => {
    return processRequest(job);
});

/** ========== Queue Status Updates ========== */
async function sendQueueStatus(chatId) {
    const jobCounts = await fileQueue.getJobCounts();
    await sendMessage(
        chatId, 
        `Queue Status:\n` +
        `- Waiting: ${jobCounts.waiting}\n` +
        `- Active: ${jobCounts.active}\n` +
        `- Completed: ${jobCounts.completed}\n` +
        `- Failed: ${jobCounts.failed}\n` +
        `- Delayed: ${jobCounts.delayed}\n\n` +
        `View dashboard at: https://telwebhook.codey.in/admin/queues`
    );
}

/** ========== Webhook Endpoint ========== */
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
    logger.info("Webhook received");
    res.send("success");

    const {message} = req.body;
    if (!message || !message.document) return;

    const chatId = message.chat.id;
    const reply = async (text) => sendMessage(chatId, text);

    await reply(`Request received for file: ${message.document.file_name}`);
    
    // Add job to Bull queue
    const job = await fileQueue.add(
        {
            fileId: message.document.file_id,
            message,
            fileName: message.document.file_name,
            name: message.document.file_name // Include name in the data for display in UI
        },
        {
            attempts: MAX_RETRIES,
            backoff: {
                type: 'exponential',
                delay: BACKOFF_DELAYS[0] * 1000 // Use the same backoff delays as defined in BACKOFF_DELAYS
            }
        }
    );
    
    await reply(`Job #${job.id} added to queue for file: ${message.document.file_name}`);
    
    // Send queue status
    await sendQueueStatus(chatId);
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
        
        await job.retry();
        res.json({ success: true, message: `Job ${jobId} queued for retry` });
    } catch (error) {
        logger.error(`Error retrying job ${jobId}: ${error}`);
        res.status(500).json({ error: error.message });
    }
});

/** ========== Fallback GET ========== */
app.get("/", (req, res) => {
    res.send(`
        <h1>Telegram File Bot</h1>
    `);
});

/** ========== Listen ========== */
app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Bull UI available at: http://localhost:${PORT}/admin/queues`);
});
