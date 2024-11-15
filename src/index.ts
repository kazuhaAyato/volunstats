import ConfigProvider from './utils/config-provider';
import express from 'express';
import bodyParser from 'body-parser';
import rateLimit from "express-rate-limit";
import { IpFilter } from "express-ipfilter"
import z from "zod";
import cors from "cors";
import pino from "pino";
import pinoHttp from "pino-http";
import pinoPretty, { PinoPretty } from "pino-pretty";

import serverRoutes from '@/api/index';
import SessionManger from './libs/session-manager';
import AuthenticationManager from './libs/authentication-manager';
import StudentDBManager from './libs/student-db-manager';
import RecruitmentDBManager from './libs/recruitment-db-manager';
import EventDBManager from './libs/event-db-manager';

import DeathEvent from "./utils/death-event";
import DatabaseWrapper from "./utils/sqlite-wrapper";

const pinoHttpConfig = {
    autoLogging: false,
    quietReqLogger: true,
    quietResLogger: true
};
const pinoPrettyConfig: PinoPretty.PrettyOptions = {
    colorize: true,
    colorizeObjects: true,
    translateTime: true,
}

const configSchema = z.object({
    DB_NAME: z.string(),
    DB_DIR: z.string(),

    SERVER_PORT: z.number(),

    IP_MAX_PER_MIN: z.number(),
    BANNED_IP: z.array(z.string()),
    TOKEN_SECRET_KEY: z.string(),
    TOKEN_SALT_ROUND: z.number(),
    TOKEN_EXPIRES_IN: z.string(),
});

const defaultConfigs: z.infer<typeof configSchema> = {
    DB_NAME: "database",
    DB_DIR: "./",

    SERVER_PORT: 3000,
    IP_MAX_PER_MIN: 100,
    BANNED_IP: [],

    TOKEN_SECRET_KEY: "secret",
    TOKEN_SALT_ROUND: 12,
    TOKEN_EXPIRES_IN: "1d",
}

const pinoPrettyInst = pinoPretty(pinoPrettyConfig);
const loggerHttp = pinoHttp(pinoHttpConfig, pinoPrettyInst)
const logger = pino(pinoPrettyInst);

const deathEvent = new DeathEvent(logger);
deathEvent.addJob(() => {
    logger.info("Shutting down server...");
    return true;
}, "Msg");

function attachRoutes(app: express.Application, sessionManager: SessionManger, studentDBManager: StudentDBManager, authenticationManager: AuthenticationManager, recruitmentDBManager: RecruitmentDBManager, eventsDBManager: EventDBManager) {
    serverRoutes.forEach(({ name, handler }) => {
        app.post(`/${name}`, (req, res) => {
            const url = req.originalUrl.split("/").pop();
            handler(req, res, sessionManager, {
                studentDBManager,
                authenticationManager,
                recruitmentDBManager,
                eventsDBManager
            })
                .catch(e => {
                    req.log.error({ handled: false, msg: `Unhandled error: ${String(e)}` });
                })
                .then(() => {
                    req.log.info({ msg: "Request handled", requestedApi: url });
                });
        });
        logger.info(`Route "${name}" is ready`);
    });
}

function initManagers(db: DatabaseWrapper, config: z.infer<typeof configSchema>) {
    return Promise.all([
        new Promise<StudentDBManager>((resolve) => {
            const studentDBManager = new StudentDBManager(db, () => resolve(studentDBManager));
        }),
        new Promise<AuthenticationManager>((resolve) => {
            const authenticationManager = new AuthenticationManager(db, () => resolve(authenticationManager), {
                secretKey: config.TOKEN_SECRET_KEY,
                saltRounds: config.TOKEN_SALT_ROUND,
                expiresIn: config.TOKEN_EXPIRES_IN
            });
        }),
        new Promise<RecruitmentDBManager>((resolve) => {
            const recruitmentDBManager = new RecruitmentDBManager(db, () => resolve(recruitmentDBManager));
        })
    ]);
}

function main(config: z.infer<typeof configSchema>) {
    return new Promise<void>((resolve, reject) => {
        try {
            const db = new DatabaseWrapper(config.DB_NAME, config.DB_DIR, deathEvent, logger);
            const port = config.SERVER_PORT;
            const sessionManager = new SessionManger();

            const limiter = rateLimit({
                windowMs: 60000,
                limit: config.IP_MAX_PER_MIN,
                message: 'Too many requests from this IP, please try again later.'
            });

            const configBannedIPs = config.BANNED_IP;
            const bannedIPs = (Array.isArray(configBannedIPs) ? configBannedIPs : []) as string[]
            const ipFilter = IpFilter(bannedIPs, { mode: 'deny' })

            logger.info("Server is starting...");
            const app = express()
                .use(bodyParser.json())
                .use(loggerHttp)
                .use(limiter)
                .use(ipFilter)
                .use(cors());

            initManagers(db, config)
                .then(([studentDBManager, authenticationManager, recruitmentDBManager]) => {
                    const eventsDBManager = new EventDBManager(db, studentDBManager, recruitmentDBManager);
                    attachRoutes(app, sessionManager, studentDBManager, authenticationManager, recruitmentDBManager, eventsDBManager);
                });

            app.listen(port, '0.0.0.0', () => {
                logger.info(`Server is running at port ${port}`);
                resolve();
            });
        } catch (e) {
            reject(e);
        }
    });
}

new ConfigProvider(configSchema, defaultConfigs).getConfig("config.yml")
    .then((config) => {
        logger.info("Config is ready");
        main(config).then(() => {
            logger.info("Server is ready");
        })
    })
    .catch((err: z.ZodError | string) => {
        if (typeof err == "string") {
            logger.error(err);
        } else {
            logger.error(
                "Fail to get all the fields for the config\n" +
                err.issues.map(issue => {
                    return `  ${issue.path.join(".")}: ${issue.message}`;
                }).join("\n")
            );
        }
    });
