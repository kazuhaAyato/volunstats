import students from "./students";
import recruitments from "./recruitment";
import events from "./events";
import authentication from "./authentication";
import { handshake, closeSession } from "./base";

export default [
    ...students,
    ...recruitments,
    ...events,
    ...authentication,
    {
        name: "handshake",
        handler: handshake
    },
    {
        name: "close-session",
        handler: closeSession
    }
];