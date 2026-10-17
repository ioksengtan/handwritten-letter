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
    ...collection("senders.json", "senders"),
    ...collection("reports.json", "reports"),
    ...collection("blocks.json", "blocks"),
  };

  function collection(filename, key) {
    const abs = path.join(dataDir, filename);
    function readItems() {
      if (!fs.existsSync(abs)) return [];
      const data = JSON.parse(fs.readFileSync(abs, "utf8"));
      return Array.isArray(data[key]) ? data[key] : [];
    }
    function writeItems(items) {
      const tmp = `${abs}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ [key]: items }, null, 2));
      fs.renameSync(tmp, abs);
    }
    if (key === "senders") {
      return {
        listSenders() {
          return readItems().slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        },
        getSender(id) {
          return readItems().find((sender) => sender.id === id) || null;
        },
        saveSender(sender) {
          const items = readItems();
          const index = items.findIndex((item) => item.id === sender.id);
          if (index < 0) items.push(sender);
          else items[index] = { ...items[index], ...sender, createdAt: items[index].createdAt };
          writeItems(items);
          return items.find((item) => item.id === sender.id);
        },
      };
    }
    if (key === "reports") {
      return {
        listReports() {
          return readItems().slice();
        },
        addReport(report) {
          const items = readItems();
          const existing = items.find((item) => (
            item.letterId === report.letterId && item.reporterId === report.reporterId
          ));
          if (existing) return existing;
          items.push(report);
          writeItems(items);
          return report;
        },
      };
    }
    return {
      listBlocks() {
        return readItems().slice();
      },
      addBlock(block) {
        const items = readItems();
        const existing = items.find((item) => (
          item.blockerId === block.blockerId && item.blockedId === block.blockedId
        ));
        if (existing) return existing;
        items.push(block);
        writeItems(items);
        return block;
      },
    };
  }
}
