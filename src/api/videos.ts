import { respondWithJSON } from "./json";
import * as fs from 'fs';
import { type ApiConfig } from "../config";
import { S3Client, type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { randomBytes } from "crypto";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {

  const uploadLimit = 1 << 30; // 1 GB

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if (file.size > uploadLimit) {
    throw new BadRequestError(
      `Video file exceeds the maximum allowed size of 1GB`,
    );
  }

  const mediaType = file.type;
  if (!mediaType) {
    throw new BadRequestError("Missing Content-Type for thumbnail");
  }
  if (mediaType != "video/mp4") {
    throw new BadRequestError("Invalid file type for a video upload");
  }

  // Create temp file
  const mediaExt = mediaType.split("/")[1];
  const tempFileString = randomBytes(32).toString("base64url");
  const tempFileName = `${tempFileString}.${mediaExt}`
  const tempFilePath = `/tmp/${tempFileName}`
  await Bun.write(tempFilePath, file);

  const s3File = S3Client.file(`${tempFileName}`);
  await s3File.write(Bun.file(tempFilePath), { type: mediaType });

  // Delete the temp file
  fs.unlink(tempFilePath, (err) => {
    if (err) throw err;
    console.log(`File at path "${tempFilePath}" deleted.`)
  })

  // Update video url in database
  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${tempFileName}`
  updateVideo(cfg.db, video);

  return respondWithJSON(200, null);
}
