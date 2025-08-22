import { type ApiConfig } from "../config";
import { getBearerToken, validateJWT } from "../auth";
import { createVideo, deleteVideo, getVideo, getVideos } from "../db/videos";
import { respondWithJSON } from "./json";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { S3Client, type BunRequest } from "bun";
import { dbVideoToSignedVideo } from "./videos";

export async function handlerVideoMetaCreate(cfg: ApiConfig, req: Request) {
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const { title, description } = await req.json();
  if (!title || !description) {
    throw new BadRequestError("Missing title or description");
  }

  const video = createVideo(cfg.db, {
    userID,
    title,
    description,
  });

  return respondWithJSON(201, video);
}

export async function handlerVideoMetaDelete(cfg: ApiConfig, req: BunRequest) {
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
    throw new UserForbiddenError("Not authorized to delete this video");
  }

  deleteVideo(cfg.db, videoId);
  return new Response(null, { status: 204 });
}

export async function handlerVideoGet(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  let video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  video = await dbVideoToSignedVideo(cfg, video);

  return respondWithJSON(200, video);
}

export async function handlerVideosRetrieve(cfg: ApiConfig, req: Request) {
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const videos = getVideos(cfg.db, userID);

  const signedVideos = await Promise.all(
    videos.map((video) => dbVideoToSignedVideo(cfg, video)),
  );

  return respondWithJSON(200, signedVideos);
}


export async function getVideoAspectRatio(filePath: string): Promise<"landscape" | "portrait" | "other"> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "json",
      filePath
    ],
    {
      stdout: "pipe",
      stderr: "pipe"
    }
  );

  // Get stdout and stderr as strings
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (stderr) {
    throw new Error(`ffprobe error: ${stderr}`);
  }
  const output = JSON.parse(stdout);
  if (!output || !output.streams || output.streams.length === 0) {
    throw new Error("No video stream found in the file");
  }
  const { width, height } = output.streams[0];
  if (typeof width !== "number" || typeof height !== "number") {
    throw new Error("Invalid width or height in video stream");
  }
  

  const aspectRatio = width / height;

  if (aspectRatio > 1.6 && aspectRatio < 1.8) {
    return "landscape";
  } else if (aspectRatio > 0.5 && aspectRatio < 0.6) {
    return "portrait";
  } else {
    return "other";
  }
}

export async function processVideoForFastStart(inputFilePath: string) {
  const processedFilePath = `${inputFilePath}.processed.mp4`;
  
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      processedFilePath,
    ],
    { stderr: "pipe" },
  );

  const errorText = await new Response(process.stderr).text();
  const exitCode = await process.exited;


  if (exitCode !== 0) {
    throw new Error(`FFmpeg error: ${errorText}`);
  }

  return processedFilePath;
}

export async function generatePresignedURL(
  cfg: ApiConfig,
  key: string,
  expireTime: number,
) {
  return cfg.s3Client.presign(`${key}`, { expiresIn: expireTime });
}