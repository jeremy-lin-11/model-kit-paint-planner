import { SamClient } from "./client";

let instance: SamClient | null = null;

/** One shared SAM worker for the app (model loads once). */
export function getSam(): SamClient {
  instance ??= new SamClient();
  return instance;
}
