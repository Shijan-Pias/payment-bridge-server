const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const crypto = require("crypto");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
// ✅ Webhook এ raw body লাগে - JSON parse করার আগেই রাখতে হবে
app.use("/api/webhook/nowpayments", express.raw({ type: "application/json" }));
app.use(express.json());

// MongoDB connect
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.a2iwzfm.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

let ordersCollection;

async function connectDB() {
  await client.connect();
  const db = client.db("paymentBridge");
  ordersCollection = db.collection("orders");
  console.log("✅ MongoDB connected successfully");
}
connectDB().catch(console.error);

// ============================================================
// ROUTE 1: সব payment method → NowPayments invoice
// bunq / Revolut / Monzo / CARD সব এখানে আসবে
// ============================================================
app.post("/api/pay/nowpayments", async (req, res) => {
  try {
    const { amount, currency = "EUR", method, customerInfo } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: "Valid amount required" });
    }

    // ✅ DB তে order save করো
    const result = await ordersCollection.insertOne({
      amount: Number(amount),
      currency: currency.toUpperCase(),
      method: method,
      status: "pending",
      customerDetails: customerInfo || null, // Card এর name + billing address
      createdAt: new Date(),
    });
    const orderId = result.insertedId.toString();

    // ✅ NowPayments invoice তৈরি করো
    const response = await axios.post(
      "https://api.nowpayments.io/v1/invoice",
      {
        price_amount: Number(amount),
        price_currency: currency.toLowerCase(), // "eur" বা "usd"
        pay_currency: process.env.NOWPAYMENTS_PAY_CURRENCY || "usdttrc20",
        order_id: orderId,
        order_description: `Payment via ${method}`,
        ipn_callback_url: `${process.env.BACKEND_URL}/api/webhook/nowpayments`,
        success_url: `${process.env.FRONTEND_URL}?status=success&orderId=${orderId}`,
        cancel_url: `${process.env.FRONTEND_URL}?status=cancel`,
      },
      {
        headers: {
          "x-api-key": process.env.NOWPAYMENTS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    // ✅ Invoice URL DB তে update করো
    await ordersCollection.updateOne(
      { _id: new ObjectId(orderId) },
      {
        $set: {
          nowpaymentsInvoiceId: response.data.id?.toString(),
          paymentUrl: response.data.invoice_url,
        },
      }
    );

    console.log(`✅ Order created: ${orderId} | Method: ${method} | Amount: ${amount} ${currency}`);

    res.json({
      success: true,
      orderId: orderId,
      paymentUrl: response.data.invoice_url,
    });

  } catch (error) {
    console.error("NowPayments error:", error.response?.data || error.message);
    res.status(500).json({ success: false, message: "Payment creation failed" });
  }
});

// ============================================================
// ROUTE 2: Order status check (frontend poll করবে)
// ============================================================
app.get("/api/order/:orderId", async (req, res) => {
  try {
    const order = await ordersCollection.findOne({
      _id: new ObjectId(req.params.orderId),
    });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    res.json({
      success: true,
      status: order.status,
      amount: order.amount,
      currency: order.currency,
      method: order.method,
      paidAt: order.paidAt || null,
    });
  } catch (error) {
    console.error("Order fetch error:", error.message);
    res.status(500).json({ success: false, message: "Error fetching order" });
  }
});

// ============================================================
// ROUTE 3: NowPayments Webhook (IPN)
// Payment হলে NowPayments এই route এ POST করবে
// Dashboard > Store Settings > IPN Callback URL = https://yourdomain.com/api/webhook/nowpayments
// ============================================================
app.post("/api/webhook/nowpayments", async (req, res) => {
  try {
    const payload = req.body.toString();
    const receivedSig = req.headers["x-nowpayments-sig"];

    // ✅ Signature verify করো (security)
    if (receivedSig && process.env.NOWPAYMENTS_IPN_SECRET) {
      const sorted = sortObject(JSON.parse(payload));
      const hmac = crypto
        .createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET)
        .update(JSON.stringify(sorted))
        .digest("hex");

      if (hmac !== receivedSig) {
        console.error("❌ Invalid webhook signature!");
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    const data = JSON.parse(payload);
    console.log(`📩 Webhook received: order_id=${data.order_id} status=${data.payment_status}`);

    // NowPayments status → আমাদের status
    const statusMap = {
      waiting: "pending",
      confirming: "processing",
      confirmed: "processing",
      sending: "processing",
      partially_paid: "processing",
      finished: "completed",    // ✅ Payment done!
      failed: "failed",
      refunded: "refunded",
      expired: "expired",
    };

    const newStatus = statusMap[data.payment_status] || "pending";

    if (data.order_id) {
      await ordersCollection.updateOne(
        { _id: new ObjectId(data.order_id) },
        {
          $set: {
            status: newStatus,
            nowpaymentsPaymentId: data.payment_id?.toString(),
            paidAt: newStatus === "completed" ? new Date() : null,
            webhookData: data,
          },
        }
      );
      console.log(`✅ Order ${data.order_id} → ${newStatus}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(400).json({ error: "Webhook processing failed" });
  }
});

// ============================================================
// Helper: Object sort (webhook signature verify এর জন্য)
// ============================================================
function sortObject(obj) {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (typeof obj !== "object" || obj === null) return obj;
  return Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortObject(obj[key]);
      return acc;
    }, {});
}

app.get("/", (req, res) => res.send("✅ Payment Bridge Server Running"));
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));