Hi, So this project is made using Codex and chatgpt, There are some issues i would like to fix one of them would be better chunking methods and some amount of fine tuning is required.

For Frontend: 
HTML
CSS
Js

For Backend:
- Node.js
- Express.js

For Model:
- Ollama

For vector DB:
- ChromaDB

For Document Processing 
- PDF Parsing


## Setup
npm install

## Start Chroma
chroma run --host localhost --port 8000

## Start Ollama
ollama serve

## Ingest PDF
node ingest.js

## Run Backend
npm start
