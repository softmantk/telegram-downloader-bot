require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {default: PQueue} = require("p-queue");

const app = express();
app.use(express.json());

/** ========== Environment Variables ========== */
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH;
const BASE_URL = process.env.BOT_SERVER_BASEURL;
console.log("CONFIG:", {PORT, BOT_TOKEN, DOWNLOAD_PATH, BASE_URL});

/** ========== Queue & Utils ========== */
const queue = new PQueue({concurrency: 1});
let statusTimer = null;
const MAX_RETRIES = 3; // Maximum attempts for both GET/POST requests

const delayFn = (timeout = 1000) => new Promise((resolve) => setTimeout(resolve, timeout));

const sendStatusUpdates = (reply) => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(async () => {
        await reply(`Queue Info: size=${queue.size}, pending=${queue.pending}`);
    }, 10000);
};

queue.on("idle", () => {
    if (statusTimer) clearInterval(statusTimer);
});

/**
 * ========== Telegram API Helpers ==========
 * We unify GET and POST in one helper.
 */
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
            // Default POST
            resp = await axios.post(url, data);
        }
        return resp.data;
    } catch (err) {
        const is429 = err?.response?.data?.error_code === 429;
        if (is429) {
            const retryAfter = err?.response?.data?.parameters?.retry_after || 30;
            console.log(`429: Too Many Requests. Attempt=${attempt}, retryAfter=${retryAfter}s`);
            await fallbackReply(`Too many requests. Waiting ${retryAfter} seconds before retry...`);
            await delayFn(retryAfter * 1000);

            if (attempt < MAX_RETRIES) {
                console.log(`Retrying (attempt ${attempt + 1})...`);
                return telegramApiRequest({
                    endpoint,
                    method,
                    data,
                    chatId,
                    fallbackReply,
                    attempt: attempt + 1,
                });
            }
            console.log("Max retries reached. Giving up.");
            throw err;
        } else {
            console.error("Telegram Error:", err.response?.data || err.message);
            throw err;
        }
    }
}

/** ========== Telegram Wrappers ========== */
const sendMessage = async (chatId, text) => {
    const responseData = await telegramApiRequest({
        endpoint: "sendMessage",
        method: "POST",
        data: {chat_id: chatId, text},
        chatId,
        fallbackReply: async (msg) => sendMessage(chatId, msg),
    });
    return responseData.result?.message_id;
};

const editMessage = async (chatId, messageId, text) => {
    await telegramApiRequest({
        endpoint: "editMessageText",
        method: "POST",
        data: {chat_id: chatId, message_id: messageId, text},
        chatId,
        fallbackReply: async (msg) => sendMessage(chatId, msg),
    });
};

/** ========== File Operations ========== */
const moveAndRenameFile = (source, destination, callback) => {
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
};

/** ========== Progress Simulation ========== */
const sendProgress = async (chatId, messageId, steps = 10, duration = 3000) => {
    const interval = duration / steps;
    let lastPercentage = 0;

    for (let i = 1; i <= steps; i++) {
        await delayFn(interval);
        const percentage = i * (100 / steps);
        if (percentage !== lastPercentage) {
            const progressBar = `[${"▓".repeat(i)}${"░".repeat(steps - i)}] ${percentage}%`;
            await editMessage(chatId, messageId, `Progress: ${progressBar}`);
            lastPercentage = percentage;
        }
    }
};

/** ========== File Processing ========== */
const processFile = async (sourcePath, targetPath, chatId, reply) => {
    // 1. Send initial message
    const msgId = await reply("Starting file move...");

    // 2. Send a fake progress bar
    await sendProgress(chatId, msgId);

    // 3. Actually move the file
    return new Promise((resolve, reject) => {
        moveAndRenameFile(sourcePath, targetPath, async (err) => {
            if (err) {
                console.error("Error moving file:", err);
                await editMessage(chatId, msgId, `Error: ${err.message}`);
                return reject(err);
            }
            await editMessage(chatId, msgId, `File successfully moved to ${targetPath}`);
            resolve();
        });
    });
};

/** ========== Main Logic: processRequest ========== */
const processRequest = async (fileId, message, reply) => {
    const chatId = message.chat.id;
    try {
        const {file_name: originalFileName} = message.document;

        // 1) We retrieve file info from Telegram (GET)
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

        console.log("File Info:", {
            originalFileName,
            fileId,
            filePathOnServer: absoluteFilePathOnServer,
            destinationPath,
        });

        // 3) Slow down if queue is heavily loaded
        if (queue.pending > 2) await delayFn(30000);

        // 4) Show user we are about to move file
        await reply(`${originalFileName}\nPreparing to move file...`);

        // 5) Process file
        await processFile(absoluteFilePathOnServer, destinationPath, chatId, reply);

        // 6) Notify success
        await reply(`${originalFileName} has been moved to ${destinationPath}`);
    } catch (error) {
        console.error("processRequest Error:", error.response?.data || error.message);
        await reply(`Error: ${error.message} \n FILE: ${message.document.file_name}`);
    }
};

/** ========== Webhook Endpoint ========== */
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
    console.log("Webhook received");
    res.send("success");

    const {message} = req.body;
    if (!message || !message.document) return;

    const chatId = message.chat.id;
    const reply = async (text) => sendMessage(chatId, text);

    await reply(`Request received for file: ${message.document.file_name}`);
    sendStatusUpdates(reply);

    // Add job to queue
    await queue.add(() => processRequest(message.document.file_id, message, reply));
});

/** ========== Fallback GET ========== */
app.get("*", (req, res) => {
    res.send("Hello World!");
});

/** ========== Listen ========== */
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
