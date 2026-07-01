// ============================================================================
// routes/analytics.js — Analytics Dashboard API
// ============================================================================

const { Router } = require("express");
const { getAnalyticsDashboard, exportEvents } = require("../controllers/analyticsController");

const router = Router();

router.get("/", getAnalyticsDashboard);
router.get("/export", exportEvents);

module.exports = router;
