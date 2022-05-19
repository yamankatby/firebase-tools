import * as express from "express";

import * as api from "../api";
import { logger } from "../logger";
import { Constants } from "./constants";
import { EmulatorInfo, EmulatorInstance, Emulators } from "./types";
import { createDestroyer } from "../utils";
import { EmulatorLogger } from "./emulatorLogger";
import { EventTrigger } from "./functionsEmulatorShared";
import { CloudEvent } from "./events/types";
import { EmulatorRegistry } from "./registry";

interface CustomEventTrigger {
  projectId: string;
  triggerName: string;
  eventTrigger: EventTrigger;
}

interface RequestWithRawBody extends express.Request {
  rawBody: Buffer;
}

export interface EventarcEmulatorArgs {
  port?: number;
  host?: string;
}

export class EventarcEmulator implements EmulatorInstance {
  private destroyServer?: () => Promise<void>;

  private logger = EmulatorLogger.forEmulator(Emulators.EVENTARC);
  private customEvents: { [key: string]: CustomEventTrigger[] } = {};

  constructor(private args: EventarcEmulatorArgs) {}

  createHubServer(): express.Application {
    const registerTriggerRoute = `/emulator/v1/projects/:project_id/triggers/:trigger_name(*)`;
    const registerTriggerHandler: express.RequestHandler = (req, res) => {
      const projectId = req.params.project_id;
      const triggerName = req.params.trigger_name;
      const body = JSON.parse((req as RequestWithRawBody).rawBody.toString());
      const eventTrigger = body.eventTrigger as EventTrigger;
      if (!eventTrigger) {
        logger.info(`Missing event trigger for ${triggerName}.`);
        res.sendStatus(400);
        return;
      }
      const key = `${eventTrigger.eventType}-${eventTrigger.channel}`;
      logger.info(`Registering custom event trigger for ${key} with trigger name ${triggerName}.`);
      const customEventTriggers = this.customEvents[key] || [];
      customEventTriggers.push({ projectId, triggerName, eventTrigger });
      this.customEvents[key] = customEventTriggers;
      res.sendStatus(200);
    };

    const publishEventsRoute = `/projects/:project_id/locations/:location/channels/:channel::publishEvents`;
    const publishEventsHandler: express.RequestHandler = (req, res) => {
      const channel = `projects/${req.params.project_id}/locations/${req.params.location}/channels/${req.params.channel}`;
      const body = JSON.parse((req as RequestWithRawBody).rawBody.toString());
      for (const event of body.events) {
        if (!event.type) {
          res.sendStatus(400);
          return;
        }
        logger.info(`Received custom event at channel ${channel}: ${JSON.stringify(event)}`);
        this.triggerCustomEventFunction(channel, event);
      }
      res.sendStatus(200);
    };

    const dataMiddleware: express.RequestHandler = (req, _, next) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        (req as RequestWithRawBody).rawBody = Buffer.concat(chunks);
        next();
      });
    };

    const hub = express();
    hub.post([registerTriggerRoute], dataMiddleware, registerTriggerHandler);
    hub.post([publishEventsRoute], dataMiddleware, publishEventsHandler);
    hub.all("*", (req, res) => {
      logger.debug(`Eventarc emulator received unknown request at path ${req.path}`);
      res.sendStatus(404);
    });
    return hub;
  }

  async triggerCustomEventFunction(channel: string, event: CloudEvent<any>) {
    const functionsEmulator = EmulatorRegistry.get(Emulators.FUNCTIONS);
    if (!functionsEmulator) {
      logger.info("Functions emulator not found. This should not happen.");
      return Promise.reject();
    }
    const key = `${event.type}-${channel}`;
    const triggers = this.customEvents[key] || [];
    return await Promise.all(
      triggers
        .filter(
          (trigger) =>
            !trigger.eventTrigger.eventFilters ||
            this.matchesAll(event, trigger.eventTrigger.eventFilters)
        )
        .map((trigger) =>
          api
            .request(
              "POST",
              `/functions/projects/${trigger.projectId}/triggers/${trigger.triggerName}`,
              {
                origin: `http://${EmulatorRegistry.getInfoHostString(functionsEmulator.getInfo())}`,
                data: JSON.stringify(event),
                json: false,
              }
            )
            .then(() => true)
            .catch((err) => {
              logger.error(
                `Failed to trigger Functions emulator for ${trigger.triggerName}: ${err}`
              );
            })
        )
    );
  }

  private matchesAll(event: CloudEvent<any>, eventFilters: Record<string, string>): boolean {
    return Object.entries(eventFilters).every(([key, value]) => {
      let attr = event[key] ?? event.attributes[key];
      if (typeof attr === "object" && !Array.isArray(attr)) {
        attr = attr.ceTimestamp ?? attr.ceString;
      }
      return attr === value;
    });
  }

  async start(): Promise<void> {
    const { host, port } = this.getInfo();
    const server = this.createHubServer().listen(port, host);
    this.destroyServer = createDestroyer(server);
    return Promise.resolve();
  }

  async connect(): Promise<void> {
    // wip. what to do here?
  }

  async stop(): Promise<void> {
    if (this.destroyServer) {
      await this.destroyServer();
    }
  }

  getInfo(): EmulatorInfo {
    const host = this.args.host || Constants.getDefaultHost(Emulators.EVENTARC);
    const port = this.args.port || Constants.getDefaultPort(Emulators.EVENTARC);

    return {
      name: this.getName(),
      host,
      port,
    };
  }

  getName(): Emulators {
    return Emulators.EVENTARC;
  }
}
