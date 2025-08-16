import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { use } from "react";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const thumbnail = formData.get("thumbnail");

  if (thumbnail === null || !(thumbnail instanceof File)) {
    throw new BadRequestError("invalid data format");
  }

  const maxUploadSize = 10 << 20;

  if (thumbnail.size > maxUploadSize) {
    throw new BadRequestError("file too large");
  }

  const mediaType = thumbnail.type;

  // Read into array buffer
  const buffer = await thumbnail.arrayBuffer();

  const metaData = getVideo(cfg.db, videoId);

  if (metaData === undefined) {
    throw new BadRequestError("video not in database");
  }

  if (metaData?.userID != userID) {
    throw new UserForbiddenError("not the owner of the video");
  }

  videoThumbnails.set(videoId, {
    data: buffer,
    mediaType: mediaType
  });

  const url = `http://localhost:${cfg.port}/api/thumbnails/${videoId}`
  metaData.thumbnailURL = url;
  updateVideo(cfg.db, metaData);

  return respondWithJSON(200, metaData);
}
