const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { put, list } = require("@vercel/blob"); // Imported 'list' to show files
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; 

// --- NEW FEATURE: Home Page to View Files ---
app.get("/", async (req, res) => {
  try {
    // Get list of all files in your Blob storage
    const { blobs } = await list({ token: process.env.BLOB_READ_WRITE_TOKEN });
    
    // Create simple HTML to display them
    let html = `
      <html>
        <head><title>My WhatsApp Docs</title></head>
        <body style="font-family: sans-serif; padding: 2rem;">
          <h1>📂 Received Documents</h1>
          <p>Total files: ${blobs.length}</p>
          <ul>
    `;

    blobs.forEach(blob => {
      html += `
        <li style="margin-bottom: 10px;">
          <a href="${blob.url}" target="_blank" style="text-decoration: none; color: blue;">
            📄 ${blob.pathname}
          </a> 
          <span style="color: gray; font-size: 0.8em;">(${new Date(blob.uploadedAt).toLocaleString()})</span>
        </li>`;
    });

    html += `</ul></body></html>`;
    res.send(html);

  } catch (error) {
    res.send(`<h1>Error loading files</h1><p>${error.message}</p>`);
  }
});

// 1. WEBHOOK VERIFICATION
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook Verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 2. RECEIVE MESSAGES
app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("Incoming Data:", JSON.stringify(body, null, 2)); // LOGS

  if (!body.object) return res.sendStatus(404);

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (message) {
      const from = message.from;
      const msgType = message.type;
      
      // Use ID from env if available, otherwise try to extract it
      const businessPhoneId = PHONE_NUMBER_ID || value.metadata.phone_number_id;

      // REACTION: Mark message as read (Optional but good user experience)
      await axios.post(
        `https://graph.facebook.com/v18.0/${businessPhoneId}/messages`,
        { messaging_product: "whatsapp", status: "read", message_id: message.id },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
      ).catch(() => {}); // Ignore error if read receipt fails

      // --- REPLY TO TEXT ---
      if (msgType === "text") {
        await sendMessage(businessPhoneId, from, "Bot is Active! Send me a PDF/Image.");
      } 
      // --- REPLY TO DOCUMENT/IMAGE ---
      else if (msgType === "document" || msgType === "image") {
        const mediaId = msgType === "document" ? message.document.id : message.image.id;
        // Use document filename or generate one for images
        const originalName = msgType === "document" ? message.document.filename : `image_${Date.now()}.jpg`;
        
        // Clean filename to remove spaces
        const fileName = originalName.replace(/\s+/g, '_');

        // 1. Get URL from Facebook
        const urlRes = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
          headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
        });
        
        // 2. Download Binary Data
        const imgRes = await axios.get(urlRes.data.url, {
          responseType: "arraybuffer",
          headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
        });

        // 3. Upload to Vercel Blob
        const blob = await put(fileName, imgRes.data, {
          access: 'public',
          token: process.env.BLOB_READ_WRITE_TOKEN
        });

        // 4. Send Reply with Link
        await sendMessage(businessPhoneId, from, `✅ Saved! View here: ${blob.url}`);
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR PROCESSING MESSAGE:", error.message);
    if(error.response) console.error(JSON.stringify(error.response.data, null, 2));
    res.sendStatus(500);
  }
});

// Helper function
async function sendMessage(phoneId, to, text) {
  try {
    await axios.post(
        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
        {
        messaging_product: "whatsapp",
        to: to,
        text: { body: text },
        },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
      console.error("Failed to send message:", err.message);
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));