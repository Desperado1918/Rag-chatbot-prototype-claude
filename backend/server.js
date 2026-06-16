const express = require("express");
const cors = require("cors");
const { askQuestion } = require("../query");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

function getUserMessage(req) {
    return req.body.message?.trim();
}

function sendError(res, error) {
    res.status(error.statusCode || 500).json({
        error: error.message || "Something went wrong",
        sources: []
    });
}

app.get("/", (req, res) => {
    res.json({
        message: "Backend is running"
    });
});

app.post("/chat", async (req, res) => {
    try {
        const userMessage = getUserMessage(req);

        if (!userMessage) {
            return res.status(400).json({
                error: "Message is required",
                sources: []
            });
        }

        const result = await askQuestion(userMessage);

        res.json({
            response: result.answer,
            sources: result.sources
        });

    } catch (error) {
        console.error(error);
        sendError(res, error);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
