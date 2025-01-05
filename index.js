require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH;
const BASE_URL = process.env.BOT_SERVER_BASEURL;
console.log('@@@ :CONFIGURATIONS: -------', { DOWNLOAD_PATH, BASE_URL });

app.use(express.json());

const sendMessage = async (chatId, text) => {
    const url = `${BASE_URL}/bot${BOT_TOKEN}/sendMessage`;
    const response = await axios.post(url, {
        chat_id: chatId,
        text: text
    });
    return response.data.result.message_id;
};

const editMessage = async (chatId, messageId, text) => {
    const url = `${BASE_URL}/bot${BOT_TOKEN}/editMessageText`;
    await axios.post(url, {
        chat_id: chatId,
        message_id: messageId,
        text: text
    });
};

// Updated function to move and rename file with fallback to copy
const moveAndRenameFile = (source, destination, callback) => {
    fs.rename(source, destination, (err) => {
        if (err) {
            if (err.code === 'EXDEV') {
                // Cross-device error, fallback to copy and delete
                const readStream = fs.createReadStream(source);
                const writeStream = fs.createWriteStream(destination);

                readStream.on('error', callback);
                writeStream.on('error', callback);

                readStream.on('close', () => {
                    fs.unlink(source, callback); // Delete the original file after copying
                });

                readStream.pipe(writeStream);
            } else {
                callback(err); // Handle other errors
            }
        } else {
            callback(null); // Success
        }
    });
};

// Simulate progress update by editing messages
const sendProgress = async (chatId, reply, messageId, duration = 3000) => {
    const steps = 10;
    const interval = duration / steps;
    let lastPercentage = 0;

    for (let i = 1; i <= steps; i++) {
        await new Promise(resolve => setTimeout(resolve, interval));
        const percentage = i * 10;

        if (percentage !== lastPercentage) {
            const progressBar = `[${'▓'.repeat(i)}${'░'.repeat(steps - i)}] ${percentage}%`;
            await editMessage(chatId, messageId, `Progress: ${progressBar}`);
            lastPercentage = percentage;
        }
    }
};

// Function to handle file processing
const processFile = async (filePath, destinationPath, chatId, reply) => {
    const initialMessageId = await reply("Starting file move...");

    await sendProgress(chatId, reply, initialMessageId); // Simulate progress

    return new Promise((resolve, reject) => {
        moveAndRenameFile(filePath, destinationPath, async (err) => {
            if (err) {
                console.error('Error moving file:', err);
                await editMessage(chatId, initialMessageId, `Error moving file: ${err.message}`);
                reject(err);
            } else {
                console.log(`File moved to ${destinationPath}`);
                await editMessage(chatId, initialMessageId, `File moved successfully to ${destinationPath}`);
                resolve();
            }
        });
    });
};

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
    console.log("Received webhook");
    const message = req.body.message;
    res.send("success");
    const chatId = message.chat.id;
    const reply = async (text) => await sendMessage(chatId, text);
    console.log("MESSAGE: ", JSON.stringify(message, null,2));
    if (message && message.document) {
        const fileId = message.document.file_id;
        const originalFileName = message.document.file_name;

        try {
            await reply(`Getting your file into our bot server...\n ${originalFileName}`);
            const url = `${BASE_URL}/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
            // Use BASE_URL from environment variables to get file path
            console.log("URL: ", url)
            const fileUrlResponse = await axios.get(url);

            const filePath = path.join(fileUrlResponse.data.result.file_path); // Absolute path to the file

            const destinationPath = path.join(DOWNLOAD_PATH, originalFileName);

            console.log("FILE : ", JSON.stringify({
                fileUrlResponse: fileUrlResponse.data,
                filePath,
                destinationPath
            },null,2));

            await reply(`${originalFileName}\nMoving file...`);
            await processFile(filePath, destinationPath, chatId, reply);

            await reply(`${originalFileName}\nFile moved to ${destinationPath}`);
        } catch (error) {
            console.error('Error:', error.response ? error.response.data : error);
            await reply(`Error processing file: ${error.message}`);
        }
    } else {
        await reply('No document found in the message.');
    }
});

app.get("*", (req, res) => {
    res.send("Hello world");
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
