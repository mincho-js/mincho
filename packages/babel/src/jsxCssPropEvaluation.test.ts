import { describe, expect, it } from "vitest";
import { babelTransform, runJsxCssPropRuntime } from "./testUtils/plugin.js";

describe.each([false, true])(
  "CSS evaluation before runtime assembly (codegen=%s)",
  (runtimeCodegen) => {
    const run = (source: string, result: string) =>
      runJsxCssPropRuntime(source, result, runtimeCodegen);

    it.each([
      "key={i.id} css={{color: i.color}}",
      'title={read()} css={{color: i.color}} hidden aria-label="item"',
      "key={i.id} css={{color: i.color}} hidden={true} tabIndex={-1}"
    ])(
      "keeps direct CSS inline with unobservable trailing attributes: %s",
      (attributes) => {
        const { code } = babelTransform(
          `const App = (items, read) => items.map(i => <li ${attributes} />);`,
          { jsxCssProp: true, optimize: { runtimeCodegen } }
        );

        expect(code).not.toContain("(() =>");
        expect(code).not.toContain("_minchoProps");
        expect(code).not.toContain("_minchoCssValue");
      }
    );

    it("keeps await before direct CSS in its async context", async () => {
      const source = `const events = [];
        async function read() { events.push('id'); return 'item'; }
        function color() { events.push('color'); return 'red'; }
        async function App(read, color) { return [<div id={await read()} css={{color: color()}} hidden />]; }`;

      expect(
        await run(source, "return App(read, color).then(() => events);")
      ).toEqual(["id", "color"]);
    });

    it("keeps yield before direct CSS in its generator context", () => {
      const source = `const events = [];
        function color() { events.push('color'); return 'red'; }
        function* App(color) { return [<div id={yield 'id'} css={{color: color()}} hidden />]; }`;

      expect(
        run(
          source,
          `const iterator=App(color); const first=iterator.next();
        const suspended=events.slice(); const last=iterator.next('item');
        return { first, suspended, events, id:last.value[0].id, done:last.done };`
        )
      ).toEqual({
        first: { value: "id", done: false },
        suspended: [],
        events: ["color"],
        id: "item",
        done: true
      });
    });

    it("keeps CSS reads after observable attributes following an earlier style", () => {
      expect(
        run(
          `const events=[];
        function read(name) { events.push(name); return 4; }
        function App(read) { return <div style={{opacity:read('style')}} id={read('id')} css={{width:read('css')}} />; }`,
          "App(read); return events;"
        )
      ).toEqual(["style", "id", "css"]);
    });

    it("stages direct CSS before an observable trailing attribute", () => {
      expect(
        run(
          `const events=[];
          function read(name) { events.push(name); return 4; }
          function App(read) { return <div css={{width:read('css')}} id={read('after')} />; }`,
          "App(read); return events;"
        )
      ).toEqual(["css", "after"]);
    });

    it("evaluates earlier values before later guards and post-css attributes", () => {
      expect(
        run(
          `
      const events = [];
      function read(name, value) { events.push(name); return value; }
      const pre = { get title() { return read("spread", "title"); } };
      function App(read) { return <div {...pre} css={{
        width: read("width", 4),
        color: read("condition", true) ? "red" : read("inactive", "blue")
      }} id={read("after", "id")} />; }
    `,
          "App(read); return events;"
        )
      ).toEqual(["spread", "width", "condition", "after"]);
    });

    it("preserves lazy nested reads and evaluates repeated getters independently", () => {
      expect(
        run(
          `
      const events = [];
      function read(name, value) { events.push(name); return value; }
      const values = { get width() { return read("width", 4); } };
      function App(read, values) { return <div css={{
        width: values.width,
        height: values.width,
        color: read("outer", true) ?
          (read("inner", false) ? read("inactive", "red") : read("selected", "blue")) : read("inactive", "green")
      }} />; }
    `,
          "App(read, values); return events;"
        )
      ).toEqual(["width", "width", "outer", "inner", "selected"]);
    });

    it("performs suffix coercion before the following CSS value", () => {
      expect(
        run(
          `
      const events = [];
      const size = { toString() { events.push("coerce"); return "4"; } };
      function next() { events.push("next"); return "red"; }
      function App(size, next) { return <div css={{width: \`\${size}px\`, color: next()}} />; }
    `,
          "App(size, next); return events;"
        )
      ).toEqual(["coerce", "next"]);
    });

    it("stops at the first throwing value before evaluating later conditions", () => {
      expect(
        run(
          `
      const events = [];
      function first() { events.push("first"); throw new Error("stop"); }
      function later() { events.push("later"); return true; }
      function App() { return <div css={{width: first(), color: later() ? "red" : "blue"}} />; }
    `,
          "try { App(); } catch(error) { events.push(error.message); } return events;"
        )
      ).toEqual(["first", "stop"]);
    });

    it("captures explicit key/ref in source order and keeps intervening spread overrides", () => {
      expect(
        run(
          `
      const events = [];
      function read(name) { events.push(name); return name; }
      const a = { get key() { return read("spread-a"); } };
      const b = { get key() { return read("spread-b"); }, get ref() { return read("ref-b"); } };
      function App(read) { return <div key={read("key-a")} {...a}
        key={read("key-middle")} ref={read("ref-middle")} {...b}
        css={{width: +read("css")}} id={read("after")} />; }
    `,
          "const props = App(read); return {events, key:props.key, ref:props.ref};"
        )
      ).toEqual({
        events: [
          "key-a",
          "spread-a",
          "key-middle",
          "ref-middle",
          "spread-b",
          "ref-b",
          "css",
          "after"
        ],
        key: "spread-b",
        ref: "ref-b"
      });
    });

    it("keeps symbols and __proto__ data without changing user objects", () => {
      expect(
        run(
          `
      const symbol = Symbol("prop");
      const prototype = { marker:true };
      const input = { [symbol]: 1, ["__proto__"]: prototype, style:{opacity:0.5} };
      function App(value) { return <div {...input} css={{width:value}} />; }
    `,
          `const props=App(4); return {
      own: Object.hasOwn(props,"__proto__"), value:props.__proto__===prototype,
      prototype:Object.getPrototypeOf(props)===Object.prototype, symbol:props[symbol],
      untouched:Object.keys(input).join(",")
    };`
        )
      ).toEqual({
        own: true,
        value: true,
        prototype: true,
        symbol: 1,
        untouched: "__proto__,style"
      });
    });

    it.each([
      '__proto__={prototype} {...input} css={{color:"red"}}',
      'css={{color:"red"}} {...input} __proto__={prototype}',
      "__proto__={prototype} {...input} css={{width:value}}",
      "css={{width:value}} {...input} __proto__={prototype}"
    ])(
      "keeps an explicit __proto__ as an own data property: %s",
      (attributes) => {
        expect(
          run(
            `const __proto__="wrong";
          const prototype={marker:true};
          const input={id:"item"};
          function App(value) { return <div ${attributes} />; }`,
            `const props=App(4); return {
            own:Object.hasOwn(props,"__proto__"),
            value:props.__proto__===prototype,
            prototype:Object.getPrototypeOf(props)===Object.prototype,
            wrong:Object.hasOwn(props,__proto__)
          };`
          )
        ).toEqual({ own: true, value: true, prototype: true, wrong: false });
      }
    );

    it("reads a JSX namespace getter before staging CSS and attributes", () => {
      expect(
        run(
          `
      const events=[];
      const UI={get Button(){events.push("type");return ()=>null;}};
      function read(name,value){events.push(name);return value;}
      function App(UI,read){return [<UI.Button css={{width:read("css",4)}} title={read("after","title")}/>];}
    `,
          "App(UI,read); return events;"
        )
      ).toEqual(["type", "css", "after"]);
    });

    it("retains custom element tag strings when staging attributes", () => {
      const { code } = babelTransform(
        'function App(size) {return <My-element css={{width:size}} id="after"/>;}',
        { jsxCssProp: true, optimize: { runtimeCodegen } }
      );

      expect(code).toContain("<My-element");
      expect(code).not.toContain("= My-element");
    });

    it("reads a this element before attributes in a derived constructor", () => {
      expect(
        run(
          "const events=[]; class App extends Object {constructor(read){<this css={{width:read()}} id={read()}/>; super();}}",
          'try{new App(()=>events.push("css"));}catch(error){events.push(error.name);}return events;'
        )
      ).toEqual(["ReferenceError"]);
    });

    it("throws a component TDZ error before evaluating staged attributes", () => {
      expect(
        run(
          `
      const events=[];
      function read(){events.push("css");return 4;}
      function App(read){return <Component css={{width:read()}} id="after"/>;const Component=()=>null;}
    `,
          "try{App(read);}catch(error){events.push(error.name);}return events;"
        )
      ).toEqual(["ReferenceError"]);
    });

    it("emits independent static branch classes without style or vx", () => {
      const { code, result } = babelTransform(
        `
      function App(a,b,c,d,e) { return <div css={{
        color:a?"red":"blue", backgroundColor:b?"white":"black",
        display:c?"flex":"block", position:d?"relative":"absolute", overflow:e?"hidden":"auto"
      }} />; }
    `,
        { jsxCssProp: true, optimize: { runtimeCodegen: true } }
      );

      expect(result[1].match(/_css\(/g)).toHaveLength(10);
      expect(code).not.toContain("style=");
      expect(code).not.toContain("transform-runtime");
      expect(result[1]).not.toContain("createVar");
    });

    it.each([
      'padding:a?"8px":"4px",paddingLeft:b?"16px":"2px"',
      'insetInlineStart:a?"8px":"4px",left:b?"16px":"2px"',
      'width:a?"8px":"4px",inlineSize:b?"16px":"2px"',
      'color:a?"red":"blue",all:b?"initial":"unset"',
      'transform:a?"none":"scale(1)",WebkitTransform:b?"none":"scale(2)"'
    ])(
      "keeps potentially overlapping declarations together: %s",
      (declarations) => {
        expect(
          run(
            `function App(a,b) { return <div css={{${declarations}}}/>; }`,
            "return App(true,false).className;"
          )
        ).toBe("css-rule");
      }
    );
  }
);
