const fs = require("fs");
const path = require("path");
const util = require("util");
const unzipper = require("unzipper");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");

const deletePath = async (filePath) => {
  if (fs.existsSync(filePath)) {
    if (fs.lstatSync(filePath).isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(filePath);
    }
  }
};

const moveContents = async (srcDir, destDir, filter = () => true) => {
  const files = fs.readdirSync(srcDir).filter(filter);
  for (const file of files) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);
    fs.renameSync(srcPath, destPath);
  }
};

const parseArcProj = (content) => {
  const data = {};
  const lines = content.split("\n");
  lines.forEach((line) => {
    const [key, value] = line.split(":").map((str) => str.trim());
    if (key && value) {
      data[key] = value;
    }
  });
  return data;
};

const allowedScenecontrolValues = [
  "trackdisplay",
  "redline",
  "arcahvdistort",
  "arcahvdebris",
  "hidegroup",
  "enwidencamera",
  "enwidenlanes",
];

const allowedTiminggroupValues = ["anglex", "angley", "noinput", "fadingholds"];

const processAffFiles = async (innerFolder) => {
  const affFiles = fs
    .readdirSync(innerFolder)
    .filter((file) => file.endsWith(".aff"));

  if (affFiles.length === 0) {
    console.error("No .aff files found!");
    return;
  }

  if (affFiles.length > 1) {
    console.log("Multiple .aff files found!");
    affFiles.forEach((file, index) => {
      console.log(`${index + 1}. ${file}`);
    });

    for (const file of affFiles) {
      const oldPath = path.join(innerFolder, file);
      console.log(`Enter new name for ${file}:`);
      const newName = await new Promise((resolve) => {
        process.stdin.once("data", (data) => resolve(data.toString().trim()));
      });
      const newPath = path.join(innerFolder, newName);
      fs.renameSync(oldPath, newPath);
      console.log(`Renamed ${file} to ${newName}`);
    }
  } else if (affFiles.length === 1) {
    const singleAffPath = path.join(innerFolder, affFiles[0]);
    let content = await fs.promises.readFile(singleAffPath, "utf8");

    content = content
      .split("\n")
      .map((line) => line.replace(/\s+/g, ""))
      .join("\n");

    // scenecontrol() modification
    content = content
      .replace(
        /scenecontrol\(([^,]+),\s*([^,]+?)\s*(?:,([^,]+))?(?:,([^,]+))?(?:,([^,]+))?(?:,([^,]+))?\);/g,
        (match, p1, p2, p3, p4, p5, p6) => {
          if (/[A-Z]/.test(p2)) {
            return "";
          }

          const trimmedP2 = p2.trim();
          if (
            p2.includes('"') ||
            p2.includes("'") ||
            !allowedScenecontrolValues.includes(trimmedP2)
          ) {
            return "";
          }

          if (p3 && !p3.includes(".")) {
            return `scenecontrol(${p1.trim()},${p2.trim()},${parseFloat(
              p3.trim()
            ).toFixed(2)},${p4 ? p4.trim() : ""},${p5 ? p5.trim() : ""},${
              p6 ? p6.trim() : ""
            });`;
          }

          return `scenecontrol(${p1.trim()},${p2.trim()},${
            p3 ? p3.trim() : ""
          },${p4 ? p4.trim() : ""},${p5 ? p5.trim() : ""},${
            p6 ? p6.trim() : ""
          });`;
        }
      )
      .replace(/^\s*[\r\n]/gm, "");

    // timinggroup() modification
    content = content.replace(/timinggroup\(([^)]*)\)\s*{/g, (match, p1) => {
      const params = p1.split(",").map((param) => param.trim());
      const invalidParams = params.some(
        (param) =>
          !allowedTiminggroupValues.includes(param) && !/^[_\d.]+$/.test(param)
      );

      if (invalidParams) {
        return `timinggroup(){`;
      }

      return match;
    });

    // arc() modification
    content = content.replace(
      /arc\((\d+),(\d+),([\d.]+),([\d.]+),(\w+),([\d.]+),([\d.]+),(\d+),(\w+),(\w+)\)/g,
      (match, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10) => {
        if (p1 === p2) {
          const newP2 = parseInt(p2, 10) + 1;
          return `arc(${p1},${newP2},${p3},${p4},${p5},${p6},${p7},${p8},${p9},${p10})`;
        }
        return match;
      }
    );

    await fs.promises.writeFile(singleAffPath, content, "utf8");
    console.log(`Processed ${affFiles[0]}`);

    for (let i = 0; i < 3; i++) {
      const newFilePath = path.join(innerFolder, `${i}.aff`);
      await fs.promises.copyFile(singleAffPath, newFilePath);
      console.log(`Created duplicate: ${i}.aff`);
    }
  }
};

async function processArcPkg(filePath) {
  const baseDir = path.dirname(filePath);
  const fileName = path.basename(filePath, ".arcpkg");
  const zipPath = path.join(baseDir, `${fileName}.zip`);
  fs.renameSync(filePath, zipPath);

  const extractDir = path.join(baseDir, `extracted_${fileName}`);
  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: extractDir }))
    .promise();

  const innerFolders = fs
    .readdirSync(extractDir)
    .filter((f) => fs.lstatSync(path.join(extractDir, f)).isDirectory());
  if (innerFolders.length === 0) {
    console.error("Unexpected file structure! (Is this a valid .arcpkg file?)");
    return;
  }

  const innerFolderName = innerFolders[0];
  const innerFolder = path.join(extractDir, innerFolderName);
  const arcprojPath = path.join(innerFolder, "project.arcproj");
  if (!fs.existsSync(arcprojPath)) {
    console.error(
      "'project.arcproj' File not found! (Is this a valid .arcpkg file?)"
    );
    return;
  }

  const arcprojContent = await fs.promises.readFile(arcprojPath, "utf8");
  const arcprojData = parseArcProj(arcprojContent);

  const songlistData = {
    idx: 0,
    id: innerFolderName.toLowerCase().replace(/[^a-z0-9]/g, ""),
    title_localized: { en: arcprojData.title },
    artist: arcprojData.composer,
    search_title: { ja: arcprojData.title, ko: arcprojData.title },
    search_artist: { ja: arcprojData.composer, ko: arcprojData.composer },
    bpm: arcprojData.bpmText,
    bpm_base: parseFloat(arcprojData.baseBpm),
    set: "custom",
    purchase: innerFolderName,
    audioPreview: 0,
    audioPreviewEnd: 0,
    side: 0,
    bg: "",
    bg_inverse: "",
    remote_dl: true,
    world_unlock: false,
    date: Math.floor(Date.now() / 1000),
    version: "",
    difficulties: [
      {
        ratingClass: 0,
        chartDesigner: arcprojData.charter,
        jacketDesigner: arcprojData.illustrator,
        rating: parseInt(arcprojData.difficulty.replace(/\D+/g, "")),
        ...(arcprojData.difficulty.includes("+") && { ratingPlus: true }),
      },
      {
        ratingClass: 1,
        chartDesigner: arcprojData.charter,
        jacketDesigner: arcprojData.illustrator,
        rating: parseInt(arcprojData.difficulty.replace(/\D+/g, "")),
        ...(arcprojData.difficulty.includes("+") && { ratingPlus: true }),
      },
      {
        ratingClass: 2,
        chartDesigner: arcprojData.charter,
        jacketDesigner: arcprojData.illustrator,
        rating: parseInt(arcprojData.difficulty.replace(/\D+/g, "")),
        ...(arcprojData.difficulty.includes("+") && { ratingPlus: true }),
      },
    ],
  };

  const songlistPath = path.join(innerFolder, "songlist");
  await fs.promises.writeFile(
    songlistPath,
    JSON.stringify(songlistData, null, 2),
    "utf8"
  );

  const images = fs
    .readdirSync(innerFolder)
    .filter((file) => /\.(jpg|png)$/i.test(file));
  for (const image of images) {
    const imagePath = path.join(innerFolder, image);
    const metadata = await sharp(imagePath).metadata();
    if (metadata.width === metadata.height) {
      await sharp(imagePath)
        .resize(768, 768)
        .toFile(path.join(innerFolder, "1080_base.jpg"));
      await sharp(imagePath)
        .resize(384, 384)
        .toFile(path.join(innerFolder, "1080_base_256.jpg"));
      await deletePath(imagePath);
      break;
    }
  }

  const audioFiles = fs
    .readdirSync(innerFolder)
    .filter((file) => /\.(mp3|ogg)$/i.test(file));
  for (const audio of audioFiles) {
    const audioPath = path.join(innerFolder, audio);
    if (audio !== "base.ogg") {
      const tempPath = path.join(innerFolder, "base.ogg");
      try {
        await new Promise((resolve, reject) => {
          ffmpeg(audioPath)
            .toFormat("ogg")
            .on("end", resolve)
            .on("error", reject)
            .save(tempPath);
        });
        await deletePath(audioPath);
      } catch (error) {
        console.error("Failed generating 'base.ogg':", error);
        return;
      }
    }
  }

  const previewPath = path.join(innerFolder, "preview.ogg");
  const baseAudioPath = path.join(innerFolder, "base.ogg");
  if (fs.existsSync(baseAudioPath)) {
    const startTime = await new Promise((resolve) => {
      console.log(
        "Enter start time for preview: (Should only be numbers. ex: Enter 90 for 1:30.)"
      );
      process.stdin.once("data", (data) =>
        resolve(parseInt(data.toString().trim(), 10))
      );
    });
    try {
      await new Promise((resolve, reject) => {
        ffmpeg(baseAudioPath)
          .setStartTime(startTime)
          .setDuration(20)
          .audioFilters(["afade=t=in:ss=0:d=1", "afade=t=out:st=19:d=1"])
          .on("end", resolve)
          .on("error", reject)
          .save(previewPath);
      });
    } catch (error) {
      console.error("Failed generating 'preview.ogg':", error);
      return;
    }
  } else {
    console.error("'base.ogg' not found! Failed generating 'preview.ogg'.");
    return;
  }

  const dlFolder = path.join(
    baseDir,
    `dl_${innerFolderName.toLowerCase().replace(/[^a-z0-9]/g, "")}`
  );
  if (!fs.existsSync(dlFolder)) fs.mkdirSync(dlFolder);
  await moveContents(innerFolder, dlFolder, (file) =>
    ["1080_base.jpg", "1080_base_256.jpg", "preview.ogg"].includes(file)
  );

  const targetFolder = path.join(
    baseDir,
    innerFolderName.toLowerCase().replace(/[^a-z0-9]/g, "")
  );
  if (!fs.existsSync(targetFolder)) fs.mkdirSync(targetFolder);

  const filesToDelete = fs
    .readdirSync(innerFolder)
    .filter((file) => file === "project.arcproj" || file.endsWith(".json"));
  for (const file of filesToDelete) {
    const filePath = path.join(innerFolder, file);
    await deletePath(filePath);
  }

  await processAffFiles(innerFolder);
  await moveContents(innerFolder, targetFolder);
  await deletePath(extractDir);
  await deletePath(filePath);
  await deletePath(zipPath);
  await deletePath(arcprojPath);

  console.log(
    `Processing complete. Files are saved in ${dlFolder} and ${targetFolder}`
  );
  process.exit(1);
}

const inputFilePath = process.argv[2];
if (inputFilePath) {
  processArcPkg(inputFilePath).catch((err) => console.error(err));
} else {
  console.error("Wrong Usage: Command should be 'node aka.js [ARCPKG_PATH]'.");
  process.exit(1);
}
