import AsyncStorage from "./environment-storage";
import { Directory, File, Paths } from "expo-file-system";
import { fileBackedStore } from "./file-backed-store";

const directory = () => {
  const dir = new Directory(Paths.document, "traivo-offline");
  dir.create({ intermediates: true, idempotent: true });
  return dir;
};
function file(reference: string) {
  if (!/^[a-z0-9_-]+\.json$/.test(reference)) throw new Error("OFFLINE_STORAGE_INVALID_REFERENCE");
  return new File(directory(), reference);
}
export default fileBackedStore(AsyncStorage, {
  write: async value => {
    const name = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}.json`;
    file(name).write(value);
    return name;
  },
  read: async reference => file(reference).text(),
  remove: async reference => { const stored = file(reference); if (stored.exists) stored.delete(); },
});
