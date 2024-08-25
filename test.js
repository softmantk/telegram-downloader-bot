require('dotenv').config()
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH;
const baseUrl = process.env.BOT_SERVER_BASEURL;

;(async () => {
    const fileId = 'BQACAgQAAxkBAAMoZnUyb2ReM-XabxjPBxb3ol0wijoAAo8SAAK1nWFSU2Ju1m1yaUc1BA'
    try {
        const fileUrl = `${ baseUrl }/bot${ BOT_TOKEN }/getFile?file_id=${ fileId }`;
        console.log("fileurl: ", fileUrl);
        const fileResponse = await axios.get(fileUrl);
        console.log('@@@ :fileResponse.data: ', fileResponse.data);
        const filePath = fileResponse.data.result.file_path;
        console.log('@@@ :filePath: ', filePath);

        const fileLink = `${ baseUrl }/file/bot${ BOT_TOKEN }/${ filePath }`;
        console.log("fileLink: ", fileLink);
        const fileName = path.basename(filePath);
        const fileDestination = path.join(DOWNLOAD_PATH, fileName);
        const writer = fs.createWriteStream(fileDestination);

        const downloadResponse = await axios({
            url: fileLink,
            method: 'GET',
            responseType: 'stream'
        });

        downloadResponse.data.pipe(writer);

        writer.on('finish', () => {
            console.log("DONE;")
        });

        writer.on('error', ( err ) => {
            console.error('Error downloading file:', err);
        });
    }
    catch (e) {
        console.log('@@@ :e.response: ', e.response.data);
    }
})();
