import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createStoryPackage } from "../web/src/story/package";
import { storyTutorials, tutorialCategories } from "../web/src/story/tutorials";

const output = resolve("web/public/tutorials");
await mkdir(output, { recursive: true });

const catalog = {
  version: 1,
  categories: tutorialCategories,
  tutorials: storyTutorials.map(({ archive: _archive, ...tutorial }) => ({
    ...tutorial,
    file: `${tutorial.id}.ssp`,
  })),
};

for (const tutorial of storyTutorials) {
  const packageBlob = await createStoryPackage(tutorial.archive);
  await writeFile(resolve(output, `${tutorial.id}.ssp`), new Uint8Array(await packageBlob.arrayBuffer()));
}
await writeFile(resolve(output, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(`Generated ${storyTutorials.length} built-in tutorial SSP files in ${output}`);
