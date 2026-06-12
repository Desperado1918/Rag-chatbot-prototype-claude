const express = require("express");
const cors = require("cors");
const { askQuestion } = require("../query");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        message: "Backend is running"
    });
});

app.post("/chat", async (req, res) => {
    try {
        const userMessage = req.body.message;

        if (!userMessage || !userMessage.trim()) {
            return res.status(400).json({
                error: "Message is required"
            });
        }

        const result = await askQuestion(userMessage);

        res.json({
            response: result.answer,
            sources: result.sources
        });

    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message || "Something went wrong"
        });
    }
});

app.listen(3000, () => {
    console.log("Server running on port 3000");
});
