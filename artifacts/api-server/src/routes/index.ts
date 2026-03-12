import { Router, type IRouter } from "express";
import healthRouter from "./health";
import vehiclesRouter from "./vehicles";
import stopsRouter from "./stops";
import routesRouter from "./routes";
import dashboardRouter from "./dashboard";
import optimizeRouter from "./optimize";
import sustainabilityRouter from "./sustainability";
import aiChatRouter from "./ai-chat";
import insightsRouter from "./insights";

const router: IRouter = Router();

router.use(healthRouter);
router.use(vehiclesRouter);
router.use(stopsRouter);
router.use(routesRouter);
router.use(dashboardRouter);
router.use(optimizeRouter);
router.use(sustainabilityRouter);
router.use(aiChatRouter);
router.use(insightsRouter);

export default router;
