import { Worker } from "node:worker_threads";
import { Note } from "./core";

export function regexSearch(notes: Note[], query: string): Promise<Note[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');try{const {search}=require(workerData.core);parentPort.postMessage({ids:search(workerData.notes,workerData.query,true).map(n=>n.id)});}catch(e){parentPort.postMessage({error:e.message});}`,
      {
        eval: true,
        workerData: { core: require.resolve("./core"), notes, query },
      },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("正規表現検索が時間制限（2秒）を超えました"));
    }, 2000);
    worker.once("message", (message) => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.error) reject(new Error(message.error));
      else {
        const map = new Map(notes.map((note) => [note.id, note]));
        resolve(message.ids.map((id: string) => map.get(id)!));
      }
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(error);
    });
  });
}
