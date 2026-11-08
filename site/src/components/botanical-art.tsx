export function SproutMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M20 35V16M20 25 9 14M20 19 31 8"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        d="M19 19C6 21 3 11 5 5c10-1 17 5 14 14ZM22 15C20 4 28 1 36 3c0 9-5 15-14 12Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ArrowIcon({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={diagonal ? "M6 18 18 6M6 6h12v12" : "M4 12h15m-6-6 6 6-6 6"}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Decorative branches and leaves, drawn as vectors for every screen size. */
export function BotanicalArt() {
  return (
    <svg
      className="mincho-botanical-art"
      viewBox="0 0 560 600"
      preserveAspectRatio="xMidYMin slice"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id="leaf-dots"
          width="9"
          height="9"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="3" cy="3" r="1.7" fill="#17231a" />
        </pattern>
        <path id="leaf-shape" d="M0 0C-66-7-74-56-49-79-17-72 14-43 0 0Z" />
      </defs>
      <g stroke="#17231a" strokeWidth="19" strokeLinecap="square">
        <path d="M88-34 89-80M343-30 344-80M493-24 493-80M181-16 140-60" />
        <path d="m79 621 9-655M331 627 343-30m155 674-5-668" />
        <path d="m-5 187 596-118M74 489l449-140M181-16l163 178m-5 143L514 191M340 473 473 600" />
      </g>
      <g stroke="#17231a" strokeWidth="3">
        <path d="m177 179 45-131m153 66 59-83m-88 311 92-113m54 240-92-117M94 551 26 461" />
        <g transform="translate(224 59) rotate(15)">
          <use href="#leaf-shape" fill="#e4e84e" />
          <use href="#leaf-shape" fill="url(#leaf-dots)" />
          <path d="M0 0c-17-20-28-43-45-66" />
        </g>
        <g transform="translate(201 115) rotate(112) scale(.8)">
          <use href="#leaf-shape" fill="#e8ebc9" />
          <path d="M0 0c-17-20-28-43-45-66" />
        </g>
        <g transform="translate(423 47) rotate(88)">
          <use href="#leaf-shape" fill="#e4e84e" />
          <use href="#leaf-shape" fill="url(#leaf-dots)" />
          <path d="M0 0c-17-20-28-43-45-66" />
        </g>
        <g transform="translate(439 223) rotate(105) scale(1.25)">
          <use href="#leaf-shape" fill="#e8ebc9" />
          <use href="#leaf-shape" fill="url(#leaf-dots)" />
          <path d="M0 0c-17-20-28-43-45-66" />
        </g>
        <g transform="translate(415 423) rotate(-22) scale(1.25)">
          <use href="#leaf-shape" fill="#e4e84e" />
          <use href="#leaf-shape" fill="url(#leaf-dots)" />
          <path d="M0 0c-17-20-28-43-45-66" />
        </g>
        <g transform="translate(37 478) rotate(-20) scale(.8)">
          <use href="#leaf-shape" fill="#e8ebc9" />
          <path d="M0 0c-17-20-28-43-45-66" />
        </g>
      </g>
      <g fill="#17231a">
        <path d="M111 230c38-6 46 22 20 40-26-4-34-24-20-40ZM459 526c-27 25-10 53 17 48 14-19 5-39-17-48Z" />
        <circle cx="277" cy="77" r="6" />
        <circle cx="275" cy="94" r="6" />
        <circle cx="272" cy="111" r="6" />
      </g>
    </svg>
  );
}
