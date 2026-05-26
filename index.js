const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const crypto = require("crypto");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use('/api/webhook/nowpayments', express.raw({ type: 'application/json' }));
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.a2iwzfm.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true } });

let ordersCollection;

async function connectDB() {
  await client.connect();

  
  const db = client.db("paymentBridge");
  ordersCollection = db.collection("orders");
  console.log("MongoDB connected");
}
connectDB().catch(console.error);

// ============================================
// ROUTE 1: bunq / iDEAL / Bancontact
// bunq.me URL generate → frontend QR বানাবে
// ============================================
app.post("/api/pay/bunq", async (req, res) => {
  try {
    const { amount, method } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: "Valid amount required" });

    const methodMap = { 'BUNQ': 'BUNQ_TRANSFER', 'IDEAL': 'IDEAL', 'BANCONTACT': 'BANCONTACT' };
    const bunqMethod = methodMap[method] || 'BUNQ_TRANSFER';
    const paymentUrl = `https://bunq.me/${process.env.BUNQ_ME_USERNAME}?amount=${amount}&paymentMethod=${bunqMethod}`;

    const result = await ordersCollection.insertOne({
      amount: Number(amount), currency: 'EUR', method, paymentType: 'BUNQ',
      status: 'pending', paymentUrl, createdAt: new Date()
    });

    res.json({ success: true, orderId: result.insertedId.toString(), paymentUrl });
  } catch (error) {
    console.error("bunq error:", error.message);
    res.status(500).json({ success: false, message: "Failed" });
  }
});

// ============================================
// ROUTE 2: NowPayments Invoice (Card/Crypto)
// ============================================
app.post("/api/pay/nowpayments", async (req, res) => {
  try {
    const { amount, method } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: "Valid amount required" });

    const result = await ordersCollection.insertOne({
      amount: Number(amount), currency: 'EUR', method, paymentType: 'NOWPAYMENTS',
      status: 'pending', createdAt: new Date()
    });
    const orderId = result.insertedId.toString();

    const response = await axios.post('https://api.nowpayments.io/v1/invoice', {
      price_amount: Number(amount),
      price_currency: 'eur',
      pay_currency: process.env.NOWPAYMENTS_PAY_CURRENCY || 'usdttrc20',
      order_id: orderId,
      order_description: `Payment - ${method}`,
      ipn_callback_url: `${process.env.BACKEND_URL}/api/webhook/nowpayments`,
      success_url: `${process.env.FRONTEND_URL}/payment-success?orderId=${orderId}`,
      cancel_url: `${process.env.FRONTEND_URL}`,
    }, { headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' } });

    await ordersCollection.updateOne(
      { _id: new ObjectId(orderId) },
      { $set: { paymentUrl: response.data.invoice_url, nowpaymentsId: response.data.id } }
    );

    res.json({ success: true, orderId, paymentUrl: response.data.invoice_url });
  } catch (error) {
    console.error("NowPayments error:", error.response?.data || error.message);
    res.status(500).json({ success: false, message: "Payment creation failed" });
  }
});

// ============================================
// ROUTE 3: Order Status Check
// ============================================
app.get("/api/order/:orderId", async (req, res) => {
  try {
    const order = await ordersCollection.findOne({ _id: new ObjectId(req.params.orderId) });
    if (!order) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, status: order.status, amount: order.amount, method: order.method, paidAt: order.paidAt || null });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error" });
  }
});

// ============================================
// ROUTE 4: NowPayments Webhook (IPN)
// NowPayments Dashboard > Store Settings > IPN Callback URL = https://yourdomain.com/api/webhook/nowpayments
// ============================================
app.post("/api/webhook/nowpayments", async (req, res) => {
  try {
    const payload = req.body.toString();
    const receivedSig = req.headers['x-nowpayments-sig'];

    if (receivedSig && process.env.NOWPAYMENTS_IPN_SECRET) {
      const sorted = sortObject(JSON.parse(payload));
      const hmac = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET).update(JSON.stringify(sorted)).digest('hex');
      if (hmac !== receivedSig) {
        console.error("Invalid webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    const data = JSON.parse(payload);
    const statusMap = {
      'waiting': 'pending', 'confirming': 'processing', 'confirmed': 'processing',
      'sending': 'processing', 'partially_paid': 'processing',
      'finished': 'completed', 'failed': 'failed', 'refunded': 'refunded', 'expired': 'expired',
    };

    if (data.order_id) {
      await ordersCollection.updateOne(
        { _id: new ObjectId(data.order_id) },
        { $set: { status: statusMap[data.payment_status] || 'pending', nowpaymentsPaymentId: data.payment_id?.toString(), paidAt: data.payment_status === 'finished' ? new Date() : null, webhookData: data } }
      );
      console.log(`Order ${data.order_id} → ${data.payment_status}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(400).json({ error: "Failed" });
  }
});

function sortObject(obj) {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (typeof obj !== 'object' || obj === null) return obj;
  return Object.keys(obj).sort().reduce((acc, key) => { acc[key] = sortObject(obj[key]); return acc; }, {});
}

app.get("/", (req, res) => res.send("Payment Bridge Server Running"));
app.listen(port, () => console.log(`Server running on port ${port}`));