const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const messages = document.getElementById("messages");
const statusText = document.getElementById("status");

function addMessage(text, type) {
    const message = document.createElement("div");
    message.className = `message ${type}`;
    message.textContent = text;
    messages.appendChild(message);
    messages.scrollTop = messages.scrollHeight;
    return message;
}

function updateMessage(message, text, type) {
    message.className = `message ${type}`;
    message.textContent = text;
    messages.scrollTop = messages.scrollHeight;
}

chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const userMessage = messageInput.value.trim();

    if (!userMessage) {
        return;
    }

    addMessage(userMessage, "user");
    const pendingMessage = addMessage("Thinking...", "bot pending");
    messageInput.value = "";
    messageInput.disabled = true;
    chatForm.querySelector("button").disabled = true;
    statusText.textContent = "Thinking";

    try {
        const response = await fetch("http://localhost:3000/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                message: userMessage
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Request failed");
        }

        updateMessage(pendingMessage, data.response, "bot");
    } catch (error) {
        updateMessage(pendingMessage, error.message, "bot error");
    } finally {
        messageInput.disabled = false;
        chatForm.querySelector("button").disabled = false;
        statusText.textContent = "Ready";
        messageInput.focus();
    }
});
