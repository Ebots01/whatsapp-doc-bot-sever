// index.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');

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
// DATABASE CONNECTION (Optimized for Vercel)
// -------------------------------------------------------------
// We use a cached connection to prevent crashing on "cold starts"
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

const fileSchema = new mongoose.Schema({
  pathname: String,
  mime_type: String,
  timestamp: String,
  whatsapp_id: String,
  url: String,
  from_mobile: String, // Store who sent it
  createdAt: { 
    type: Date, 
    default: Date.now, 
    expires: 600 // Auto-delete after 10 mins
  } 
});

// Use 'models.File' to prevent OverwriteModelError in serverless mode
const FileModel = mongoose.models.File || mongoose.model('File', fileSchema);

// -------------------------------------------------------------
// HELPER: SEND MESSAGE BACK TO WHATSAPP
// -------------------------------------------------------------
async function sendReply(businessPhoneId, toMobile, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${businessPhoneId}/messages`,
      {
        messaging_product: "whatsapp",
        to: toMobile,
        text: { body: text }
      },
      {
        headers: { 
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json' 
        }
      }
    );
    console.log(`📤 Reply sent to ${toMobile}`);
  } catch (error) {
    console.error("❌ Failed to send reply:", error.response ? error.response.data : error.message);
  }
}

// -------------------------------------------------------------
// 1. WEB UI
// -------------------------------------------------------------
app.get('/', async (req, res) => {
  try {
    await connectToDatabase(); // Ensure DB is connected
    const files = await FileModel.find().sort({ createdAt: -1 });

    const fileRows = files.map(f => `
      <tr class="hover:bg-gray-50 border-b">
        <td class="px-6 py-4 text-sm text-gray-700">${f.timestamp}</td>
        <td class="px-6 py-4 font-medium text-gray-900 flex items-center gap-2">
          <span class="text-green-600">📄</span> ${f.pathname}
        </td>
        <td class="px-6 py-4 text-sm text-gray-500">${f.from_mobile || 'Unknown'}</td>
        <td class="px-6 py-4">
          <a href="${f.url}" target="_blank" class="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 text-sm transition">
            Download
          </a>
        </td>
      </tr>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>WhatsApp Server</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <meta http-equiv="refresh" content="30">
      </head>
      <body class="bg-gray-50 p-10 font-sans">
        <div class="max-w-5xl mx-auto bg-white shadow-xl rounded-2xl overflow-hidden">
          <div class="bg-teal-600 p-8 text-white">
            <h1 class="text-3xl font-bold">WhatsApp Documents</h1>
            <p>Files auto-delete after 10 mins</p>
          </div>
          <table class="w-full text-left">
            <thead>
              <tr class="bg-gray-100">
                <th class="px-6 py-4">Time</th>
                <th class="px-6 py-4">Filename</th>
                <th class="px-6 py-4">Sender</th>
                <th class="px-6 py-4">Action</th>
              </tr>
            </thead>
            <tbody>${fileRows || '<tr><td colspan="4" class="p-10 text-center">No files yet</td></tr>'}</tbody>
          </table>
          <form action="/api/clear-all" method="POST" class="p-4 text-center">
             <button type="submit" class="text-red-500 hover:underline">Clear All Data</button>
          </form>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send("Server Error");
  }
});

// -------------------------------------------------------------
// 2. WEBHOOK (Receive & Reply)
// -------------------------------------------------------------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && 
      req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(400);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Immediately respond 200 OK to WhatsApp so they don't retry/ban us
  res.sendStatus(200);

  try {
    if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const change = body.entry[0].changes[0].value;
      const msg = change.messages[0];
      const businessPhoneId = change.metadata.phone_number_id; // Your Bot ID
      const userMobile = msg.from; // The User's Mobile

      // Handle Documents
      if (msg.type === 'document') {
        await connectToDatabase(); // Connect to DB

        const doc = msg.document;
        const newFile = {
          pathname: doc.filename || `doc_${msg.timestamp}.pdf`,
          mime_type: doc.mime_type,
          timestamp: new Date().toLocaleTimeString(),
          whatsapp_id: doc.id,
          from_mobile: userMobile,
          url: `${SERVER_URL}/api/proxy/${doc.id}`
        };

        // 1. Save to DB
        await FileModel.create(newFile);
        console.log(`✅ Saved file from ${userMobile}`);

        // 2. Send "Pin" / Confirmation back to user
        await sendReply(businessPhoneId, userMobile, `✅ Received: ${newFile.pathname}\nCheck the server dashboard to download.`);
      }
      
      // Handle Text Messages (Optional Debugging)
      else if (msg.type === 'text') {
        console.log(`💬 Text from ${userMobile}: ${msg.text.body}`);
        // Uncomment below to echo text back
        // await sendReply(businessPhoneId, userMobile, "I only accept documents (PDF/Doc)!"); 
      }
    }
  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
  }
});

// -------------------------------------------------------------
// 3. PROXY & API
// -------------------------------------------------------------
app.get('/api/files', async (req, res) => {
  await connectToDatabase();
  const files = await FileModel.find().sort({ createdAt: -1 });
  res.json(files);
});

app.post('/api/clear-all', async (req, res) => {
  await connectToDatabase();
  await FileModel.deleteMany({});
  res.redirect('/');
});

app.get('/api/proxy/:mediaId', async (req, res) => {
  try {
    const urlResponse = await axios.get(`https://graph.facebook.com/v17.0/${req.params.mediaId}`, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });
    const fileResponse = await axios({
      method: 'get',
      url: urlResponse.data.url,
      responseType: 'stream',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });
    res.setHeader('Content-Type', urlResponse.data.mime_type);
    fileResponse.data.pipe(res);
  } catch (error) {
    res.status(500).send("Error fetching file.");
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));