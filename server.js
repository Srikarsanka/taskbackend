/**
 * server.js - Main backend file for Personal Productivity Dashboard
 * This file sets up the Express server, connects to MongoDB,
 * and defines all the REST API routes for task management.
 */

// Load environment variables from .env file
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const admin = require("firebase-admin");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Firebase Admin Initialization ──────────────────────────────────────────────
// This requires a service account JSON file from your Firebase console.
// Place `firebase-service-account.json` in the backend folder.
try {
  const serviceAccount = require("./firebase-service-account.json");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("🔥 Firebase Admin initialized");
} catch (err) {
  console.warn("⚠️ Firebase Admin not initialized (missing firebase-service-account.json)");
}

// ─── Middleware ───────────────────────────────────────────────────────────────
// Allow requests from the frontend (CORS)
app.use(cors());
// Parse incoming JSON request bodies
app.use(express.json());

// ─── MongoDB Connection ───────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI, {
    dbName: "productivity_dashboard", // Use a dedicated database
  })
  .then(() => console.log("✅ Connected to MongoDB Atlas"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ─── Task Schema & Model ──────────────────────────────────────────────────────
/**
 * Each task document in MongoDB has:
 *  - task_name   : the name/description of the task (required)
 *  - completed   : whether the task has been completed (default false)
 *  - created_at  : timestamp when the task was created
 *  - is_default  : flag to identify default seeded tasks
 */
const taskSchema = new mongoose.Schema({
  task_name: {
    type: String,
    required: true,
    trim: true,
  },
  completed: {
    type: Boolean,
    default: false,
  },
  created_at: {
    type: Date,
    default: Date.now,
  },
  is_default: {
    type: Boolean,
    default: false,
  },
});

const Task = mongoose.model("Task", taskSchema);

// ─── User/Device Token Schema ─────────────────────────────────────────────────
// To store FCM device tokens so the server knows where to send notifications.
const deviceSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
});
const Device = mongoose.model("Device", deviceSchema);

// ─── Helper: Seed Default Tasks ───────────────────────────────────────────────
/**
 * Seeds the three default daily tasks if no default tasks exist.
 * Called after MongoDB connects successfully.
 */
async function seedDefaultTasks() {
  try {
    const defaultCount = await Task.countDocuments({ is_default: true });
    if (defaultCount === 0) {
      const defaults = [
        { task_name: "Push code to GitHub (at least one commit)", is_default: true },
        { task_name: "Learn Flask / APIs",                        is_default: true },
        { task_name: "Chat with ChatGPT for 10 minutes",          is_default: true },
      ];
      await Task.insertMany(defaults);
      console.log("🌱 Default tasks seeded");
    }
  } catch (err) {
    console.error("Error seeding default tasks:", err);
  }
}

// Seed after connection is ready
mongoose.connection.once("open", seedDefaultTasks);

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /tasks
 * Fetch all tasks sorted by creation date (oldest first)
 */
app.get("/tasks", async (req, res) => {
  try {
    const tasks = await Task.find().sort({ created_at: 1 });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ message: "Error fetching tasks", error: err.message });
  }
});

/**
 * POST /tasks
 * Add a new custom task
 * Body: { task_name: String }
 */
app.post("/tasks", async (req, res) => {
  try {
    const { task_name } = req.body;

    // Validate input
    if (!task_name || task_name.trim() === "") {
      return res.status(400).json({ message: "task_name is required" });
    }

    const newTask = new Task({ task_name: task_name.trim() });
    const savedTask = await newTask.save();
    
    // --- TEST FEATURE: Send notification 10 seconds after creating a task ---
    console.log("⏱️ Task added. Scheduling test notification in 10 seconds...");
    setTimeout(() => {
      sendNotificationToAll("🚀 Test Notification!", `You just added: "${savedTask.task_name}". Stay productive!`);
    }, 10000); // 10,000 milliseconds = 10 seconds
    // ------------------------------------------------------------------------

    res.status(201).json(savedTask);
  } catch (err) {
    res.status(500).json({ message: "Error creating task", error: err.message });
  }
});

/**
 * PUT /tasks/:id
 * Toggle the completion status of a task
 * Body: { completed: Boolean }
 */
app.put("/tasks/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { completed } = req.body;

    // Validate the id format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid task ID" });
    }

    const updatedTask = await Task.findByIdAndUpdate(
      id,
      { completed },
      { new: true } // Return the updated document
    );

    if (!updatedTask) {
      return res.status(404).json({ message: "Task not found" });
    }

    res.json(updatedTask);
  } catch (err) {
    res.status(500).json({ message: "Error updating task", error: err.message });
  }
});

/**
 * DELETE /tasks/:id
 * Delete a task by ID
 */
app.delete("/tasks/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid task ID" });
    }

    const deletedTask = await Task.findByIdAndDelete(id);

    if (!deletedTask) {
      return res.status(404).json({ message: "Task not found" });
    }

    res.json({ message: "Task deleted successfully", task: deletedTask });
  } catch (err) {
    res.status(500).json({ message: "Error deleting task", error: err.message });
  }
});

/**
 * GET /tasks/analytics/weekly
 * Returns task completion counts for the last 7 days (for Chart.js)
 */
app.get("/tasks/analytics/weekly", async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    // Aggregate completed tasks grouped by date
    const analytics = await Task.aggregate([
      {
        $match: {
          completed: true,
          created_at: { $gte: sevenDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$created_at" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Build a full 7-day array (fill 0 for days with no completions)
    const result = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const found = analytics.find((a) => a._id === dateStr);
      result.push({ date: dateStr, count: found ? found.count : 0 });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: "Error fetching analytics", error: err.message });
  }
});

// ─── FCM Device Token Route ───────────────────────────────────────────────────
/**
 * POST /device-token
 * Saves a new FCM device token to the database.
 */
app.post("/device-token", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "Token is required" });

    // Upsert the token
    await Device.updateOne({ token }, { token }, { upsert: true });
    res.json({ message: "Device token saved" });
  } catch (err) {
    res.status(500).json({ message: "Error saving device token", error: err.message });
  }
});

// ─── Cron Jobs for Notifications ──────────────────────────────────────────────

async function sendNotificationToAll(title, body) {
  try {
    const devices = await Device.find();
    if (devices.length === 0) return;

    const tokens = devices.map(d => d.token);
    
    // Check if there are any pending tasks
    const pendingTasks = await Task.countDocuments({ completed: false });
    if (pendingTasks === 0) return; // Everyone is done, no need to remind

    const message = {
      notification: {
        title,
        body: `${body}\nYou have ${pendingTasks} task${pendingTasks !== 1 ? 's' : ''} still pending.`
      },
      tokens
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`📡 Sent notifications: ${response.successCount} successful, ${response.failureCount} failed`);

    // Clean up invalid tokens (optional but good practice)
    if (response.failureCount > 0) {
      const failedTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(tokens[idx]);
        }
      });
      if (failedTokens.length > 0) {
        await Device.deleteMany({ token: { $in: failedTokens } });
      }
    }
  } catch (error) {
    console.error("Error sending push notifications:", error);
  }
}

// 10:00 AM Cron
cron.schedule("0 10 * * *", () => {
  console.log("⏰ Running 10:00 AM cron job");
  sendNotificationToAll("🌅 Good morning!", "Don't forget to complete your tasks today.");
});

// 10:00 PM Cron
cron.schedule("0 22 * * *", () => {
  console.log("⏰ Running 10:00 PM cron job");
  sendNotificationToAll("� It's 10 PM", "Check off your remaining tasks before the day ends!");
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
