// index.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// -------------------------------------------------------------
// CONFIGURATION
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const SERVER_URL = process.env.SERVER_URL;
const MONGODB_URI = process.env.MONGODB_URI;

// -------------------------------------------------------------
// DATABASE CONNECTION (Fixed for Vercel)
// -------------------------------------------------------------
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) {
    return cachedDb;
  }
  
  if (!MONGODB_URI) throw new Error("MONGODB_URI is missing");

  // FIXED: Removed 'bufferCommands: false' to prevent the MongooseError you saw
  const conn = await mongoose.connect(MONGODB_URI);
  
  cachedDb = conn;
  console.log("✅ New MongoDB Connection Created");
  return conn;
}

// Data Structure
const fileSchema = new mongoose.Schema({
  pin: String,
  whatsapp_id: String,
  filename: String,
  mime_type: String,
  sender_mobile: String,
  extension: String,
  createdAt: { 
    type: Date, 
    default: Date.now, 
    expires: 600 // Auto-delete after 10 mins
  } 
});

const FileModel = mongoose.models.File || mongoose.model('File', fileSchema);

// -------------------------------------------------------------
// HELPER FUNCTIONS
// -------------------------------------------------------------
function generatePin() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

async function sendMessage(phoneId, to, textBody) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${phoneId}/messages`, 
      {
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: textBody }
      },
      { 
        headers: { 
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        } 
      }
    );
    console.log(`📤 Message sent to ${to}`);
  } catch (err) {
    console.error("❌ Failed to send WhatsApp message:", err.response ? err.response.data : err.message);
  }
}

// -------------------------------------------------------------
// WEBHOOK
// -------------------------------------------------------------
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;
  res.sendStatus(200); // Reply immediately

  if (!body.object) return;

  try {
    const changes = body.entry?.[0]?.changes?.[0]?.value;
    if (!changes || !changes.messages) return;

    const message = changes.messages[0];
    const businessPhoneId = changes.metadata.phone_number_id; // THIS gets the correct ID automatically
    const from = message.from;
    const msgType = message.type;

    await connectToDatabase();

    if (msgType === "text") {
      await sendMessage(businessPhoneId, from, "👋 Send a Document or Photo to get a 4-digit PIN.");
      return;
    }

    if (msgType === "document" || msgType === "image") {
      console.log(`📂 Received ${msgType} from ${from}`);

      const mediaId = msgType === "document" ? message.document.id : message.image.id;
      const originalName = msgType === "document" ? message.document.filename : "photo";
      const mimeType = msgType === "document" ? message.document.mime_type : message.image.mime_type;
      
      let ext = ".bin";
      if (msgType === "image") ext = ".jpg";
      else if (mimeType === "application/pdf") ext = ".pdf";
      else if (originalName.includes(".")) ext = path.extname(originalName);

      const pin = generatePin();

      await FileModel.create({
        pin: pin,
        whatsapp_id: mediaId,
        filename: originalName,
        mime_type: mimeType,
        sender_mobile: from,
        extension: ext
      });

      console.log(`✅ Saved with PIN: ${pin}`);
      await sendMessage(businessPhoneId, from, `✅ *File Saved!*\n\nPIN: *${pin}*\nExpires in 10 mins.`);
    }

  } catch (error) {
    console.error("❌ Webhook Error:", error.message);
  }
});

// -------------------------------------------------------------
// DOWNLOAD ROUTE
// -------------------------------------------------------------
app.get("/download/:pin", async (req, res) => {
  try {
    await connectToDatabase();
    const { pin } = req.params;
    const file = await FileModel.findOne({ pin: pin });

    if (!file) return res.status(404).send("File not found or expired.");

    // Get URL from Facebook
    const urlResponse = await axios.get(`https://graph.facebook.com/v17.0/${file.whatsapp_id}`, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });

    // Stream file to user
    const fileResponse = await axios({
      method: 'get',
      url: urlResponse.data.url,
      responseType: 'stream',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });

    const downloadName = `${file.pin}${file.extension}`;
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    fileResponse.data.pipe(res);

  } catch (error) {
    console.error("Download Error:", error.message);
    res.status(500).send("Error fetching file.");
  }
});

// -------------------------------------------------------------
// UI DASHBOARD
// -------------------------------------------------------------
app.get("/", async (req, res) => {
  try {
    await connectToDatabase();
    const files = await FileModel.find().sort({ createdAt: -1 });

    const fileRows = files.map(file => `
        <tr>
            <td>
                <div class="file-info">
                    <span class="pin-badge">${file.pin}</span>
                    <span class="file-name">${file.filename || 'No Name'}</span>
                </div>
            </td>
            <td>${new Date(file.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
            <td><span class="status-tag">Active</span></td>
            <td>
                <div class="action-buttons">
                    <a href="/download/${file.pin}" class="btn btn-download">Download</a>
                </div>
            </td>
        </tr>
    `).join('');

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Media Gateway</title>
        <style>
            :root { --whatsapp-green: #25D366; --whatsapp-dark: #075E54; --bg: #f0f2f5; }
            body { font-family: 'Segoe UI', sans-serif; background: var(--bg); margin: 0; color: #333; }
            .header { background: var(--whatsapp-dark); color: white; padding: 1.5rem; text-align: center; }
            .container { max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
            .stats-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
            .stat-card { background: white; padding: 1.5rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); text-align: center; border-bottom: 4px solid var(--whatsapp-green); }
            .table-container { background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); overflow: hidden; }
            table { width: 100%; border-collapse: collapse; }
            th { background: #f8f9fa; padding: 1rem; text-align: left; }
            td { padding: 1rem; border-bottom: 1px solid #eee; }
            .pin-badge { background: #e7fce3; color: #128C7E; padding: 6px 12px; border-radius: 6px; font-weight: bold; font-family: monospace; font-size: 1.2rem; margin-right: 10px; }
            .status-tag { background: #fff3cd; color: #856404; padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; }
            .btn-download { display: inline-flex; padding: 8px 14px; text-decoration: none; border-radius: 6px; font-weight: 600; color: white; background-color: var(--whatsapp-green); }
            .empty-state { padding: 4rem; text-align: center; color: #888; }
        </style>
    </head>
    <body>
        <div class="header"><h1>Media Gateway</h1></div>
        <div class="container">
            <div class="stats-bar">
                <div class="stat-card"><h3>Active Files</h3><p>${files.length}</p></div>
                <div class="stat-card"><h3>Expiry</h3><p>10 Mins</p></div>
            </div>
            <div class="table-container">
                ${files.length > 0 ? `<table><thead><tr><th>PIN / File</th><th>Time</th><th>Status</th><th>Actions</th></tr></thead><tbody>${fileRows}</tbody></table>` : `<div class="empty-state"><p>No active files.</p></div>`}
            </div>
            <div style="text-align:center; margin-top: 20px;">
                <form action="/api/clear-all" method="POST"><button type="submit" style="background:none; border:none; color: #d9534f; cursor:pointer;">⚠️ Clear Database</button></form>
            </div>
        </div>
    </body>
    </html>
    `;
    res.send(html);
  } catch (error) {
    console.error(error);
    res.status(500).send("Dashboard Error");
  }
});

app.post('/api/clear-all', async (req, res) => {
  await connectToDatabase();
  await FileModel.deleteMany({});
  res.redirect('/');
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));