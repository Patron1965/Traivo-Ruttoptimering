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
import driversRouter from "./drivers";
import trackingRouter from "./tracking";
import notificationsRouter from "./notifications";
import publicTrackingRouter from "./public-tracking";
import osrmRouter from "./osrm";
import usersRouter from "./users";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(trackingRouter);
router.use(vehiclesRouter);
router.use(stopsRouter);
router.use(routesRouter);
router.use(dashboardRouter);
router.use(optimizeRouter);
router.use(sustainabilityRouter);
router.use(aiChatRouter);
router.use(insightsRouter);
router.use(driversRouter);
router.use(notificationsRouter);
router.use(publicTrackingRouter);
router.use(osrmRouter);

export default router;
