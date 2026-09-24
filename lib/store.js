import fs from "node:fs";
import path from "node:path";

export function createStore(dataDir) {
  const imagesDir = path.join(dataDir, "images");
  const file = path.join(dataDir, "letters.json");
  fs.mkdirSync(imagesDir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ letters: [] }, null, 2));
  }

  function read() {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  function write(data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    list() {
      return read().letters.slice().sort((a, b) => {
        return String(b.createdAt).localeCompare(String(a.createdAt));
      });
    },
    get(id) {
      return read().letters.find((letter) => letter.id === id) || null;
    },
    create(letter) {
      const data = read();
      data.letters.push(letter);
      write(data);
      return letter;
    },
    update(id, patch) {
      const data = read();
      const index = data.letters.findIndex((letter) => letter.id === id);
      if (index < 0) return null;
      data.letters[index] = { ...data.letters[index], ...patch };
      write(data);
      return data.letters[index];
    },
    replaceAll(letters) {
      write({ letters });
    },
    saveImage(id, buffer, ext) {
      const filename = `${id}.${ext}`;
      fs.writeFileSync(path.join(imagesDir, filename), buffer);
      return filename;
    },
    imageAbsPath(filename) {
      if (!filename) return null;
      const base = path.basename(filename);
      const abs = path.join(imagesDir, base);
      if (!fs.existsSync(abs)) return null;
      return abs;
    },
  };
}
