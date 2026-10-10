import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeFiles(root, files) {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

export const sharedCss =
  ".shared{--bench-module-shared:1;color:red;}\n" +
  Array.from(
    { length: 160 },
    (_, i) => `.token${i}{padding:${i}px;color:rgb(${i},${255 - i},${i % 97});}`
  ).join("\n");

export function appFiles(kind) {
  const html = (entry) =>
    `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="sample" class="home"></div><pre id="result"></pre><script type="module" src="/${entry}.js"></script></body></html>`;

  const finish = `document.querySelector('#result').textContent=JSON.stringify({phases,resources:performance.getEntriesByType('resource').map(r=>({name:new URL(r.name).pathname,transferSize:r.transferSize,startTime:r.startTime,duration:r.duration}))});`;
  const phase = `const phases=[]; const record=(name)=>phases.push({name,time:performance.now(),color:getComputedStyle(document.querySelector('#sample')).color,css:performance.getEntriesByType('resource').filter(r=>new URL(r.name).pathname.endsWith('.css')).map(r=>new URL(r.name).pathname)});`;
  const files = {
    "package.json": JSON.stringify({
      name: "css-app-fixture",
      type: "module",
      sideEffects: true
    }),
    "shared.css": sharedCss,
    "layout.js": 'import "./shared.css"; export const layout = "shared";',
    "home.css": ".home{--bench-module-home:1;color:black;}",

    // Route modifiers must win independently of the order in which the native
    // bundler loads a shared CSS-only chunk and route assets.
    "a.css": ".shared.route-a{--bench-module-a:1;color:blue;}",
    "b.css": ".shared.route-b{--bench-module-b:1;color:green;}"
  };

  if (kind === "spa") {
    Object.assign(files, {
      "index.html": html("main"),
      "main.js": `import './home.css'; ${phase}
        window.addEventListener('unhandledrejection',event=>{document.querySelector('#result').textContent=JSON.stringify({error:String(event.reason),phases});});
        const routes={a:()=>import('./a.js'),b:()=>import('./b.js')};
        window.addEventListener('load',async()=>{ record('initial');
          const order=new URLSearchParams(location.search).get('order')==='reverse'?['b','a','b']:['a','b','a'];
          for(const name of order){const route=await routes[name]();
            document.querySelector('#sample').className=route.className; record(name);
            if(route.evaluatedColor!==(name==='a'?'rgb(0, 0, 255)':'rgb(0, 128, 0)'))throw new Error('Unexpected CSS at module evaluation: '+route.evaluatedColor);
          } ${finish}
        });`
    });

    for (const name of ["a", "b"])
      files[`${name}.js`] =
        `import { layout } from './layout.js'; import './${name}.css';
      export const className=layout+' route-${name}';
      export const evaluatedColor=(()=>{const el=document.createElement('div');el.className=className;document.body.append(el);const color=getComputedStyle(el).color;el.remove();return color;})();`;
  } else {
    for (const name of ["a", "b"]) {
      files[`${name}.html`] = html(name);
      files[`${name}.js`] =
        `import { layout } from './layout.js'; import './${name}.css'; ${phase}
        document.querySelector('#sample').className=layout+' route-${name}';
        window.addEventListener('load',()=>{record('${name}');${finish}});`;
    }
  }

  return files;
}

export function libraryFiles(count = 12) {
  const files = {
    "package.json": JSON.stringify({
      name: "css-benchmark-ui",
      type: "module",
      sideEffects: ["**/*.css"]
    }),
    "shared.js": 'import "./shared.css"; export const shared = "shared";',
    "shared.css": sharedCss,
    "index.js": Array.from(
      { length: count },
      (_, i) => `export { component${i} } from './component${i}.js';`
    ).join("\n")
  };

  for (let i = 0; i < count; i++) {
    files[`component${i}.js`] =
      `import { shared } from './shared.js'; import './component${i}.css'; export const component${i} = shared + ' component${i}';`;
    files[`component${i}.css`] =
      `.component${i}{--bench-module-component${i}:1;color:rgb(${i},${80 + i},${150 + i});}`;
  }

  for (let group = 0; group < Math.ceil(count / 4); group++) {
    files[`group${group}.js`] = Array.from(
      { length: Math.min(4, count - group * 4) },
      (_, offset) => {
        const i = group * 4 + offset;

        return `export { component${i} } from './component${i}.js';`;
      }
    ).join("\n");
  }

  return files;
}

export function libraryEntries(root, layout, count = 12) {
  const names = [
    "index",
    ...(layout === "component"
      ? Array.from({ length: count }, (_, i) => `component${i}`)
      : layout === "group"
        ? Array.from({ length: Math.ceil(count / 4) }, (_, i) => `group${i}`)
        : [])
  ];

  return Object.fromEntries(
    names.map((name) => [name, join(root, `${name}.js`)])
  );
}
