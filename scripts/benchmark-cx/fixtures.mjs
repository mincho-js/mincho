export const artifact = {
  classWrites: Array.from({ length: 24 }, (_, property) =>
    Array.from({ length: 4 }, (_, value) => [
      `m_${property}_${value}`,
      property
    ])
  ).flat(),
  segments: [["segment", [0, 1, 2, 3]]]
};

const base = "segment m_0_0 m_1_0 m_2_0 m_3_0";
const tuples = Array.from({ length: 64 }, (_, index) => [
  base,
  `m_0_${index % 4} m_1_${(index >> 2) % 4}`,
  index % 2 === 0 && `m_2_${(index >> 4) % 4}`,
  `external-${index}`
]);

function randomOrder(count, length) {
  let state = 0x12345678;

  return Array.from({ length }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;

    return (state >>> 0) % count;
  });
}

export const names = [
  "factory",
  "first-call",
  "one-string",
  "two-strings",
  "three-conditional",
  "many-strings",
  "object-array",
  "array-single",
  "objects-hot",
  "objects-unique",
  "phase-shift",
  "long-to-unary",
  "segments-split",
  "ssr-fragment-unique",
  "capacity-65",
  "ordered-64",
  "random-64",
  "capacity-256",
  "capacity-128",
  "capacity-192",
  "capacity-512",
  "capacity-513",
  "capacity-1024",
  "capacity-2048",
  "changing-base-512",
  "random-512",
  "ssr-unique",
  "ssr-short-unique",
  "long-cacheable",
  "long-bypass",
  "unknown-noop",
  "unicode-whitespace",
  "legacy-hot",
  "legacy-512",
  "known-24-16",
  "known-256-64"
];

export function fixture(name, count) {
  if (name.startsWith("known-")) {
    const [, widthText, tokensText] = name.split("-");
    const width = Number(widthText);
    const tokenCount = Number(tokensText);
    const order = randomOrder(width * 2, 512 * tokenCount);

    return {
      artifact: {
        classWrites: Array.from({ length: width * 2 }, (_, i) => [
          `c${i}`,
          i % width
        ])
      },
      inputs: Array.from({ length: 512 }, (_, i) => [
        order
          .slice(i * tokenCount, (i + 1) * tokenCount)
          .map((id) => `c${id}`)
          .join(" ")
      ])
    };
  }

  if (name === "objects-hot" || name === "objects-unique") {
    return {
      inputs: Array.from(
        { length: name === "objects-hot" ? 16 : count },
        (_, i) => [
          "m_0_0 m_1_0",
          { m_0_1: true, [`outside-${i}`]: true },
          ["m_2_1", false]
        ]
      ),
      unique: name === "objects-unique"
    };
  }
  if (name === "phase-shift") {
    return {
      prefill: Array.from({ length: 576 }, (_, i) => ["base", `unique-${i}`]),
      inputs: [["base", "stable"]]
    };
  }
  if (name === "long-to-unary") {
    return {
      prefill: Array.from({ length: 128 }, (_, i) => [
        base,
        "x".repeat(1800) + (i % 16),
        "m_0_1"
      ]),
      inputs: [["u".repeat(3800) + " m_0_0"]]
    };
  }
  if (name === "segments-split") {
    return {
      inputs: Array.from({ length: 512 }, (_, i) => [
        "segment m_0_0",
        "m_1_0 m_2_0 m_3_0",
        `m_0_${i % 4}`,
        `external-${i}`
      ])
    };
  }
  if (name === "ssr-fragment-unique") {
    return {
      unique: true,
      inputs: Array.from({ length: count }, (_, i) => [
        `${base} external-${i}`,
        `m_0_${i % 4} m_1_${(i >> 2) % 4}`,
        i % 3 === 0 ? false : `m_2_${(i >> 4) % 4}`
      ])
    };
  }
  if (name === "changing-base-512" || name === "random-512") {
    return {
      inputs: fixture("ssr-fragment-unique", 512).inputs,
      order: name === "random-512" ? randomOrder(512, 8192) : undefined
    };
  }
  if (name === "factory" || name === "first-call") {
    return { inputs: [tuples[0]] };
  }
  if (name === "one-string") return { inputs: [[base + " m_0_1"]] };
  if (name === "two-strings") return { inputs: [[base, "m_0_1 m_1_2"]] };
  if (name === "three-conditional")
    return {
      inputs: [
        [base, "m_0_1", false],
        [base, "m_0_2", "m_2_1"]
      ]
    };
  if (name === "many-strings")
    return {
      inputs: tuples.map((tuple) => [
        ...tuple,
        "m_3_2",
        false,
        "m_4_0",
        "outside"
      ])
    };
  if (name === "object-array")
    return {
      inputs: tuples.map((tuple) => [
        [tuple[0], [tuple[1], false]],
        { [tuple[3]]: true, m_0_2: true, m_0_3: false }
      ])
    };
  if (name === "array-single")
    return {
      inputs: tuples.map((tuple) => [
        [tuple[0], { [tuple[3]]: true, m_0_2: true }, [tuple[1], false]]
      ])
    };
  if (name === "ordered-64") return { inputs: tuples };
  if (name === "random-64")
    return { inputs: tuples, order: randomOrder(64, 8192) };

  if (name.startsWith("capacity-")) {
    const size = Number(name.slice(9));

    return {
      inputs: Array.from({ length: size }, (_, i) => [
        base,
        `m_0_${i % 4}`,
        `external-${i}`
      ])
    };
  }

  if (name === "ssr-unique" || name === "ssr-short-unique")
    return {
      inputs: Array.from(
        { length: name === "ssr-short-unique" ? 256 : count },
        (_, i) => [base, `m_0_${i % 4}`, `request-${i}`]
      ),
      unique: true
    };

  if (name === "long-cacheable" || name === "long-bypass") {
    const length = name === "long-bypass" ? 4800 : 1800;

    return {
      inputs: Array.from({ length: 16 }, (_, i) => [
        base,
        "x".repeat(length) + i,
        "m_0_1"
      ])
    };
  }

  if (name === "unknown-noop")
    return {
      inputs: Array.from({ length: 512 }, (_, i) => [
        `unknown-${i} external external`
      ])
    };
  if (name === "unicode-whitespace")
    return {
      inputs: Array.from({ length: 512 }, (_, i) => [
        `\uFEFFexternal-${i}\t${base}\u2003m_0_1\n`
      ])
    };

  const legacyArtifact = {
    classWrites: [
      ["color-red", 1],
      ["color-blue", 1],
      ["padding-small", 2],
      ["padding-large", 2],
      ["display-block", 3]
    ],
    segments: [["segment", [1, 2]]]
  };

  const legacy = [
    "segment color-red padding-small color-blue",
    "segment color-blue padding-large padding-small",
    "external color-red color-blue display-block external"
  ];
  if (name === "legacy-hot")
    return { artifact: legacyArtifact, inputs: legacy.map((input) => [input]) };
  if (name === "legacy-512")
    return {
      artifact: legacyArtifact,
      inputs: Array.from({ length: 512 }, (_, i) => [
        `${legacy[i % 3]} external-${i}`
      ])
    };

  throw new Error(`Unknown cx fixture: ${name}`);
}
