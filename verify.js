// Quick verify that all modules load without errors
try {
    require("./ingest");
    require("./query");
    console.log("All modules loaded OK");
    process.exit(0);
} catch (e) {
    console.error("Module load error:", e.message);
    process.exit(1);
}
