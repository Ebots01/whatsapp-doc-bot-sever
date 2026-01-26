const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Temporary in-memory storage (Zero cost, no storage limits)
// Format: { "1234": { mediaId: "...", extension: ".pdf" } }
const fileMap = {};

function generatePin() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// 1. WEBHOOK VERIFICATION
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 2. RECEIVE MESSAGE & SAVE PIN
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (!body.object) return res.sendStatus(404);

  try {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const businessPhoneId = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

    if (message && (message.type === "document" || message.type === "image")) {
      const from = message.from;
      const msgType = message.type;
      const mediaId = msgType === "document" ? message.document.id : message.image.id;
      
      let extension = msgType === "document" 
        ? (path.extname(message.document.filename) || ".pdf") 
        : ".jpg";

      const pin = generatePin();

      // Store only the metadata in memory, NOT the file bytes
      fileMap[pin] = { mediaId, extension, timestamp: Date.now() };

      await sendMessage(businessPhoneId, from, `✅ Ready! Your PIN is: *${pin}*\n\nEnter this in the app to download.`);
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook Error:", error.message);
    res.sendStatus(500);
  }
});

// 3. STREAM FILE TO FLUTTER (The "Blob-Free" Part)
app.get("/download/:pin", async (req, res) => {
  const { pin } = req.params;
  const fileData = fileMap[pin];

  if (!fileData) {
    return res.status(404).send("PIN expired or invalid.");
  }

  try {
    // 1. Get the actual download URL from Facebook
    const urlRes = await axios.get(`https://graph.facebook.com/v24.0/${fileData.mediaId}`, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });

    // 2. Stream the file directly from WhatsApp to the Flutter client
    const response = await axios({
      method: 'get',
      url: urlRes.data.url,
      responseType: 'stream',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });

    // Pipe the WhatsApp stream directly to the Express response
    res.setHeader('Content-Disposition', `attachment; filename=${pin}${fileData.extension}`);
    response.data.pipe(res);

    // Optional: Delete PIN after successful stream to save server memory
    delete fileMap[pin];

  } catch (error) {
    res.status(500).send("Error streaming file.");
  }
});

async function sendMessage(phoneId, to, textBody) {
  try {
    await axios.post(`https://graph.facebook.com/v24.0/${phoneId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: textBody }
    }, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });
  } catch (err) { console.error("Send Error"); }
}

app.listen(PORT, () => console.log(`Server running on ${PORT}`));