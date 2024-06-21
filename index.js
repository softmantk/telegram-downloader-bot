require('dotenv').config()
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');


const app = express();
const PORT = 3000;  // Ensure this matches the port Nginx is proxying to
const BOT_TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH;
const baseUrl = process.env.BOT_SERVER_BASEURL;
console.log('@@@ :DOWNLOAD_PATH: ', DOWNLOAD_PATH);
app.use(express.json());

app.post(`/webhook/${ BOT_TOKEN }`, async ( req, res ) => {
    const message = req.body.message;

    console.log("message: ", JSON.stringify(message, null, 2))

    if (message && message.document) {
        const fileId = message.document.file_id;
        const originalFileName = message.document.file_name;
        try {
            // Get file path
            const fileUrl = `${ baseUrl }/bot${ BOT_TOKEN }/getFile?file_id=${ fileId }`;
            console.log("fileurl: ", fileUrl);
            const fileResponse = await axios.get(fileUrl);
            const filePath = fileResponse.data.result.file_path;

            const sourcePath = filePath
            const destinationPath = path.join(DOWNLOAD_PATH, originalFileName);

            console.log('@@@ :destinationPath: ', destinationPath);

            if (fs.existsSync(sourcePath)) {
                fs.rename(sourcePath, destinationPath, (err) => {
                    if (err) {
                        console.error('Error moving file:', err);
                        res.status(500).send('Error moving file.');
                    } else {
                        console.log(`File moved to ${destinationPath}`);
                        res.send('File uploaded to the server successfully.');
                    }
                });
            } else {
                console.error('File does not exist at source path:', sourcePath);
                res.status(404).send('File not found.');
            }

        }
        catch (error) {
            console.error('Error:', error && error.response ? error.response.data : error.toString());
            res.send('Error processing file.');
        }
    } else {
        res.send('No file found.');
    }
});
app.get("*", ( req, res ) => {
    console.log("Not webhook");
    res.send("Hello world");
    return;
})

app.listen(PORT, () => {
    console.log(`Server is running on port ${ PORT }`);
});

