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
const SERVER_URL = process.env.SERVER_URL; // Your Vercel URL
const MONGODB_URI = process.env.MONGODB_URI;

// -------------------------------------------------------------
// DATABASE CONNECTION (Optimized for Vercel)
// -------------------------------------------------------------
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  if (!MONGODB_URI) throw new Error("MONGODB_URI is missing");
  
  const opts = { bufferCommands: false };
  const conn = await mongoose.connect(MONGODB_URI, opts);
  cachedDb = conn;
  console.log("✅ New MongoDB Connection Created");
  return conn;
}

// Data Structure (Matches index1.js features)
const fileSchema = new mongoose.Schema({
  pin: String,            // The 4-digit PIN
  whatsapp_id: String,    // ID to fetch file from WhatsApp
  filename: String,       // Original filename
  mime_type: String,      // PDF or Image
  sender_mobile: String,
  extension: String,      // .pdf or .jpg
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
    console.error("❌ Failed to send WhatsApp message:", err.message);
  }
}

// -------------------------------------------------------------
// WEBHOOK (The "Same Logic" Fix)
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
  
  // 1. Acknowledge immediately to keep WhatsApp happy
  res.sendStatus(200);

  if (!body.object) return;

  try {
    const changes = body.entry?.[0]?.changes?.[0]?.value;
    if (!changes || !changes.messages) return;

    const message = changes.messages[0];
    const businessPhoneId = changes.metadata.phone_number_id;
    const from = message.from;
    const msgType = message.type;

    // Connect to DB only when needed
    await connectToDatabase();

    // Logic from index1.js: Handle Text
    if (msgType === "text") {
      await sendMessage(businessPhoneId, from, "👋 Send a Document or Photo to get a 4-digit PIN.");
      return;
    }

    // Logic from index1.js: Handle Media (Docs & Images)
    if (msgType === "document" || msgType === "image") {
      console.log(`📂 Received ${msgType} from ${from}`);

      // Extract details
      const mediaId = msgType === "document" ? message.document.id : message.image.id;
      const originalName = msgType === "document" ? message.document.filename : "photo";
      const mimeType = msgType === "document" ? message.document.mime_type : message.image.mime_type;
      
      // Determine extension
      let ext = ".bin";
      if (msgType === "image") ext = ".jpg";
      else if (mimeType === "application/pdf") ext = ".pdf";
      else if (originalName.includes(".")) ext = path.extname(originalName);

      const pin = generatePin();

      // Save to MongoDB
      await FileModel.create({
        pin: pin,
        whatsapp_id: mediaId,
        filename: originalName,
        mime_type: mimeType,
        sender_mobile: from,
        extension: ext
      });

      console.log(`✅ Saved with PIN: ${pin}`);

      // Send PIN back to user
      await sendMessage(businessPhoneId, from, `✅ *File Saved!*\n\nPIN: *${pin}*\nExpires in 10 mins.`);
    }

  } catch (error) {
    console.error("❌ Webhook Error:", error.message);
  }
});

// -------------------------------------------------------------
// DOWNLOAD ROUTE (The Proxy Magic)
// -------------------------------------------------------------
// This mimics the "blob" behavior. When you click download, 
// we fetch it from WhatsApp and stream it to the browser.
app.get("/download/:pin", async (req, res) => {
  try {
    await connectToDatabase();
    const { pin } = req.params;
    
    // Find file by PIN
    const file = await FileModel.findOne({ pin: pin });

    if (!file) return res.status(404).send("File not found or expired.");

    // 1. Get the download URL from Facebook
    const urlResponse = await axios.get(`https://graph.facebook.com/v17.0/${file.whatsapp_id}`, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });

    const actualUrl = urlResponse.data.url;

    // 2. Stream the file to the user
    const fileResponse = await axios({
      method: 'get',
      url: actualUrl,
      responseType: 'stream',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });

    // 3. Set headers so it downloads with the PIN name
    const downloadName = `${file.pin}${file.extension}`;
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    
    fileResponse.data.pipe(res);

  } catch (error) {
    console.error("Download Error:", error.message);
    res.status(500).send("Error fetching file from WhatsApp servers.");
  }
});

// -------------------------------------------------------------
// UI DASHBOARD (Matching index1.js Style)
// -------------------------------------------------------------
app.get("/", async (req, res) => {
  try {
    await connectToDatabase();
    // Sort by newest first
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
                    <a href="/download/${file.pin}" class="btn btn-download" title="Save to computer">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                        Download
                    </a>
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
        <title>Media Gateway (MongoDB)</title>
        <style>
            :root { --whatsapp-green: #25D366; --whatsapp-dark: #075E54; --bg: #f0f2f5; }
            body { font-family: 'Segoe UI', sans-serif; background: var(--bg); margin: 0; color: #333; }
            
            .header { background: var(--whatsapp-dark); color: white; padding: 1.5rem; text-align: center; }
            .container { max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
            
            .stats-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
            .stat-card { background: white; padding: 1.5rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); text-align: center; border-bottom: 4px solid var(--whatsapp-green); }
            
            .table-container { background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); overflow: hidden; }
            .table-header { padding: 1.5rem; border-bottom: 1px solid #eee; }
            
            table { width: 100%; border-collapse: collapse; }
            th { background: #f8f9fa; padding: 1rem; text-align: left; color: #666; font-weight: 600; border-bottom: 1px solid #eee; }
            td { padding: 1rem; border-bottom: 1px solid #eee; vertical-align: middle; }
            
            .pin-badge { background: #e7fce3; color: #128C7E; padding: 6px 12px; border-radius: 6px; font-weight: bold; font-family: monospace; font-size: 1.2rem; margin-right: 10px; border: 1px solid #c8e6c9;}
            .status-tag { background: #fff3cd; color: #856404; padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; }
            
            .action-buttons { display: flex; gap: 8px; }
            .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 0.85rem; transition: 0.2s; border: 1px solid transparent; }
            
            .btn-download { color: white; background-color: var(--whatsapp-green); }
            .btn-download:hover { background-color: #20bd5a; transform: translateY(-1px); box-shadow: 0 2px 4px rgba(0,0,0,0.08); }

            .empty-state { padding: 4rem; text-align: center; color: #888; }
        </style>
    </head>
    <body>
        <div class="header"><h1>Media Gateway</h1></div>
        <div class="container">
            <div class="stats-bar">
                <div class="stat-card"><h3>Active Files</h3><p>${files.length}</p></div>
                <div class="stat-card"><h3>Expiry</h3><p>10 Mins</p></div>
                <div class="stat-card"><h3>Storage</h3><p style="color:#25D366">MongoDB</p></div>
            </div>

            <div class="table-container">
                <div class="table-header"><h2>Received Documents</h2></div>
                ${files.length > 0 ? `
                <table>
                    <thead>
                        <tr>
                            <th>PIN / File</th>
                            <th>Time</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>${fileRows}</tbody>
                </table>
                ` : `<div class="empty-state"><p>No active files.</p></div>`}
            </div>
            
            <div style="text-align:center; margin-top: 20px;">
                <form action="/api/clear-all" method="POST">
                   <button type="submit" style="background:none; border:none; color: #d9534f; cursor:pointer;">⚠️ Clear Database</button>
                </form>
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

// Clear Data Route
app.post('/api/clear-all', async (req, res) => {
  await connectToDatabase();
  await FileModel.deleteMany({});
  res.redirect('/');
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));