import express, { type RequestHandler } from "express";
import { authenticatedSession } from "./auth.js";
import {
  MAX_SHARED_ATTACHMENTS,
  MAX_SHARED_UPLOAD_BYTES,
  uploadIdPattern,
} from "./shared-uploads.js";
import { SessionUploadError, SessionUploads } from "./session-uploads.js";

export function mountSessionUploads(
  app: express.Express,
  uploads: SessionUploads,
  auth: RequestHandler,
  origin: RequestHandler,
): void {
  const session = (request: express.Request): string => {
    const value = authenticatedSession(request);
    if (!value) throw new SessionUploadError(401, "Sign in to upload files.");
    return value;
  };
  const failure = (error: unknown, response: express.Response): void => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status =
      error instanceof SessionUploadError
        ? error.status
        : (error as NodeJS.ErrnoException).code === "EACCES" ||
            (error as NodeJS.ErrnoException).code === "EPERM"
          ? 403
          : 500;
    response
      .status(status)
      .json({
        error:
          error instanceof SessionUploadError
            ? error.message
            : "Could not store this attachment.",
      });
  };
  const safeId = (value: unknown): string => {
    const id = String(value || "").toLowerCase();
    if (!uploadIdPattern.test(id))
      throw new SessionUploadError(400, "Invalid attachment ID.");
    return id;
  };
  const setHeaders = (response: express.Response): void => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "same-origin");
  };

  app.get(
    "/api/uploads/root",
    origin,
    auth,
    (request, response) => {
      setHeaders(response);
      try {
        response.json({
          runtimeWorkspaceRoot: uploads.runtimeWorkspaceRoot(session(request)),
        });
      } catch (error) {
        failure(error, response);
      }
    },
  );

  app.post(
    "/api/uploads/retain",
    origin,
    auth,
    async (request, response) => {
      setHeaders(response);
      try {
        const body = request.body as Record<string, unknown>;
        if (
          !body ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => key !== "ids") ||
          !Array.isArray(body.ids) ||
          body.ids.length > MAX_SHARED_ATTACHMENTS ||
          body.ids.some((id) => typeof id !== "string")
        ) {
          throw new SessionUploadError(400, "Invalid attachment IDs.");
        }
        await uploads.retain(session(request), body.ids as string[]);
        response.json({ retained: true });
      } catch (error) {
        failure(error, response);
      }
    },
  );

  app.post(
    "/api/uploads/:id",
    origin,
    auth,
    (request, response, next) => {
      setHeaders(response);
      express.raw({ type: () => true, limit: MAX_SHARED_UPLOAD_BYTES })(
        request,
        response,
        (error) => {
          if (error) {
            response
              .status((error as { status?: number }).status === 413 ? 413 : 400)
              .json({ error: "Each file must be 32 MB or smaller." });
            return;
          }
          next();
        },
      );
    },
    async (request, response) => {
      try {
        const encodedName = request.header("x-file-name") || "";
        let name: string;
        try {
          name = decodeURIComponent(encodedName);
        } catch {
          throw new SessionUploadError(400, "Invalid filename.");
        }
        if (!name || name.length > 1024 || !Buffer.isBuffer(request.body))
          throw new SessionUploadError(
            400,
            "Upload a file with its filename.",
          );
        const entry = await uploads.put(
          session(request),
          safeId(request.params.id),
          name,
          request.body,
        );
        response.status(201).json(entry);
      } catch (error) {
        failure(error, response);
      }
    },
  );

  app.delete(
    "/api/uploads/:id",
    origin,
    auth,
    async (request, response) => {
      setHeaders(response);
      try {
        await uploads.remove(session(request), safeId(request.params.id));
        response.json({ removed: true });
      } catch (error) {
        failure(error, response);
      }
    },
  );
}
