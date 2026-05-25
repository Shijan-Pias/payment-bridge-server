const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios"); // NOWPayments এ কল করার জন্য
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.a2iwzfm.mongodb.net/?appName=Cluster0`;

// Create a MongoClient
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server
    await client.connect();

    // ডাটাবেস এবং কালেকশন তৈরি
    const db = client.db("paymentBridge");
    const ordersCollection = db.collection("orders");

    // ==========================================
    // পেমেন্ট API Route (ফ্রন্টএন্ড এখানে রিকোয়েস্ট পাঠাবে)
    // ==========================================
    app.post("/api/pay", async (req, res) => {
      try {
        const { amount, method } = req.body;

        // ১. ডেটাবেসে অর্ডারটি 'pending' হিসেবে সেভ করা
        const newOrder = {
          amount: Number(amount),
          currency: 'EUR',
          method: method,
          status: 'pending',
          createdAt: new Date()
        };
        const result = await ordersCollection.insertOne(newOrder);
        const orderId = result.insertedId.toString(); // MongoDB এর তৈরি করা ইউনিক আইডি

        // ২. NOWPayments API-তে রিকোয়েস্ট পাঠানো
        const paymentData = {
          price_amount: amount,
          price_currency: 'EUR',
          pay_currency: 'USDTTRC20', // ক্লায়েন্ট ক্রিপ্টোতে রিসিভ করবে
          order_id: orderId, // আমাদের ডাটাবেসের আইডি
          order_description: `Payment via ${method}`
        };

        const response = await axios.post('https://api.nowpayments.io/v1/invoice', paymentData, {
          headers: {
            'x-api-key': process.env.NOWPAYMENTS_API_KEY,
            'Content-Type': 'application/json'
          }
        });

        // ৩. NOWPayments থেকে পাওয়া লিংক ডেটাবেসে আপডেট করে ফ্রন্টএন্ডে পাঠানো
        const paymentUrl = response.data.invoice_url;
        
        await ordersCollection.updateOne(
          { _id: new ObjectId(orderId) },
          { $set: { paymentUrl: paymentUrl } }
        );

        res.status(200).json({ 
          success: true, 
          paymentUrl: paymentUrl 
        });

      } catch (error) {
        console.error("NOWPayments API Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: "Payment creation failed" });
      }
    });
    // ==========================================

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Payment Bridge Server Running");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});