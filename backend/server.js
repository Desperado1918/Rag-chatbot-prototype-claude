const express = require("express");
const cors = require("cors");
const { askQuestion, askQuestionStream } = require("../query");
const { ingestDocument, normalizeChunkingMethod } = require("../ingest");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

function getUserMessage(req) {
    return req.body.message?.trim();
}

function getChunkingMethod(req) {
    return normalizeChunkingMethod(req.body.chunkingMethod);
}

function sendJsonError(res, error) {
    res.status(error.statusCode || 500).json({
        error: error.message || "Something went wrong",
        sources: []
    });
}

function writeSse(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get("/", (req, res) => {
    res.json({
        message: "Backend is running"
    });
});

app.post("/ingest", async (req, res) => {
    try {
        const chunkingMethod = getChunkingMethod(req);
        const result = await ingestDocument(undefined, { chunkingMethod });

        res.json(result);
    } catch (error) {
        console.error(error);
        sendJsonError(res, error);
    }
});

app.post("/chat", async (req, res) => {
    try {
        const userMessage = getUserMessage(req);
        const chunkingMethod = getChunkingMethod(req);

        if (!userMessage) {
            return res.status(400).json({
                error: "Message is required",
                sources: []
            });
        }

        const result = await askQuestion(userMessage, { chunkingMethod });

        res.json({
            response: result.answer,
            sources: result.sources,
            chunkingMethod: result.chunkingMethod
        });
    } catch (error) {
        console.error(error);
        sendJsonError(res, error);
    }
});

app.post("/chat/stream", async (req, res) => {
    const userMessage = getUserMessage(req);
    const chunkingMethod = getChunkingMethod(req);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    if (!userMessage) {
        writeSse(res, "error", {
            error: "Message is required"
        });
        res.end();
        return;
    }

    try {
        await askQuestionStream(
            userMessage,
            { chunkingMethod },
            {
                onSources: (sources, selectedMethod) => {
                    writeSse(res, "sources", {
                        sources,
                        chunkingMethod: selectedMethod
                    });
                },
                onToken: (token) => {
                    writeSse(res, "token", {
                        token
                    });
                },
                onDone: () => {
                    writeSse(res, "done", {
                        done: true
                    });
                    res.end();
                }
            }
        );
    } catch (error) {
        console.error(error);
        writeSse(res, "error", {
            error: error.message || "Something went wrong"
        });
        res.end();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
