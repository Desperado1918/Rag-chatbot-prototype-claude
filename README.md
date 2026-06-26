# RAG Research Assistant

AI-powered document Q&A chatbot that answers questions **strictly from your uploaded PDFs** — research papers, textbooks, notes. No hallucination, no outside knowledge.

## Architecture

```
User Question → PageIndex (tree-based retrieval) → Qwen 2.5 7B via Ollama (grounded generation) → Streamed Answer
```

- **Retrieval**: [PageIndex](https://pageindex.ai) — vectorless, reasoning-based document indexing. Parses document structure (headings, sections, tables, figures) into a navigable tree.
- **Generation**: [Qwen 2.5 7B](https://ollama.com/library/qwen2.5) via [Ollama](https://ollama.com) — local LLM that generates answers grounded strictly in retrieved context.
- **Frontend**: HTML/CSS/JS with Space Grotesk typography, glassmorphism UI, drag-and-drop PDF upload.
- **Backend**: Node.js + Express with SSE streaming.

## Prerequisites

- [Node.js](https://nodejs.org) (v18+)
- [Ollama](https://ollama.com) installed and running
- [PageIndex API key](https://dash.pageindex.ai)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Pull the Qwen 2.5 7B model
ollama pull qwen2.5:7b

# 3. Configure environment
cp .env.example .env
# Edit .env and add your PAGEINDEX_API_KEY

# 4. Start Ollama (if not already running)
ollama serve

# 5. Start the server
npm start
```

Open **http://localhost:3000** in your browser.

## Usage

1. **Upload a PDF** — drag and drop onto the upload zone, or click to browse
2. **Ask questions** — type your question in the chat input
3. **Get grounded answers** — responses come strictly from the document content

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML, CSS (Space Grotesk), Vanilla JS |
| Backend | Node.js, Express |
| Retrieval | PageIndex SDK |
| Generation | Ollama (Qwen 2.5 7B) |
| File Upload | Multer |
| Streaming | Server-Sent Events (SSE) |

## CLI Usage

```bash
# Ingest a specific PDF
node ingest.js ./path/to/paper.pdf

# Query from CLI
node query.js "What is the main contribution of this paper?"
```
