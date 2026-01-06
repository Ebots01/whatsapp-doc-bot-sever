// index.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { put } = require("@vercel/blob"); // For file storage
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // You define this password

// 1. WEBHOOK VERIFICATION (Required by WhatsApp to prove you own the server)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// 2. RECEIVE MESSAGES (POST)
app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Check if this is an event from a WhatsApp message
  if (body.object) {
    if (
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {
      const message = body.entry[0].changes[0].value.messages[0];
      const from = message.from; // The user's phone number
      const msgType = message.type;

      // Check if message is a Document or Image
      if (msgType === "document" || msgType === "image") {
        
        // Get the Media ID (WhatsApp gives an ID, not the file directly)
        const mediaId = msgType === "document" ? message.document.id : message.image.id;
        const mimeType = msgType === "document" ? message.document.mime_type : message.image.mime_type;
        const fileName = msgType === "document" ? message.document.filename : `image_${Date.now()}.jpg`;

        try {
            // STEP A: Get the URL of the image using the Media ID
            const urlResponse = await axios.get(
                `https://graph.facebook.com/v18.0/${mediaId}`,
                { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
            );
            const mediaUrl = urlResponse.data.url;

            // STEP B: Download the binary data
            const binaryResponse = await axios.get(mediaUrl, {
                responseType: "arraybuffer",
                headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
            });

            // STEP C: Upload to Vercel Blob (Permanent Storage)
            // This replaces "saving to disk" since Vercel has no disk
            const blob = await put(fileName, binaryResponse.data, {
                access: 'public',
                token: process.env.BLOB_READ_WRITE_TOKEN
            });

            console.log("File saved at:", blob.url);

            // STEP D: Send "Thank You" Reply
            await axios.post(
                `https://graph.facebook.com/v18.0/${body.entry[0].changes[0].value.metadata.phone_number_id}/messages`,
                {
                    messaging_product: "whatsapp",
                    to: from,
                    text: { body: `Thank you! I have received your ${msgType} and saved it.` },
                },
                { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
            );

        } catch (error) {
            console.error("Error processing file:", error.message);
        }
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, () => console.log(`Server is listening on port ${PORT}`));