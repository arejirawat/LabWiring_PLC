/**
 * Electrical Control Wiring Simulator & Auto-Verification Engine
 * อ้างอิงใบงานที่ 1 (การต่อวงจรสวิตช์ NO/NC) และ ใบงานที่ 2 (การต่อวงจรรีเลย์เบื้องต้น MY2N-J)
 * รองรับ:
 * 1. การคลิกพักสายไฟ (Multi-point Waypoint Wire Routing) เพื่อเดินสายอ้อมจุดเชื่อมต่อและป้องกันสายซ้อนทับกัน
 * 2. สวิตช์กดค้างสถานะ (Toggle Hold / Momentary Mode) เพื่อให้สามารถกด S1 และ S2 ค้างพร้อมกันได้ง่าย (เช่น วงจร AND)
 * 3. สัญลักษณ์สวิตช์และรีเลย์ตามมาตรฐานวิชาการ IEC 60617 (NO = ปกติเปิดด้านซ้าย กดแล้วปิดเข้าขั้ว / NC = ปกติแตะขั้วด้านขวา กดแล้วผลักเปิดออก)
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// Application State
const MAX_UNDO_STEPS = 5;
const BASE_VIEWBOX = { w: 920, h: 620 };

const state = {
  currentLabId: 'lab1_1',
  powerOn: true,
  wireColor: '#ef4444',
  wires: [], // { id, from, to, color, waypoints: [{x, y}, ...] }
  undoStack: [], // Stores up to MAX_UNDO_STEPS (5) snapshots of wires
  redoStack: [],
  liveTestedRows: {}, // Stores live test results for truth table: { [rowIdx]: { passed, actual: { L1, L2, RELAY } } }
  lastVerificationResults: null, // Cached automated verification results
  showingHints: false,
  selectedTerminal: null,
  activeWaypoints: [], // [{x, y}] while routing a wire
  draggingFrom: null,
  pointerDownPos: null,
  zoom: 1,
  viewBox: { x: 0, y: 0, w: 920, h: 620 },
  panMode: false,
  switches: {
    // Default locked: true so clicking S1 or S2 holds its state (ON/OFF) by default for easy multi-switch testing
    S1: { pressed: false, locked: true },
    S2: { pressed: false, locked: true }
  },
  simResult: {
    shortCircuit: false,
    L1: false,
    L2: false,
    K1: false,
    K2: false,
    posTerminals: new Set(),
    negTerminals: new Set()
  }
};

// Lab Curriculum Definitions (Based on Doc1 & Doc2) with clean non-overlapping hint waypoints
const LABS = {
  lab1_1: {
    id: 'lab1_1',
    title: 'ใบงานที่ 1 (ตอนที่ 1): วงจรสวิตช์อนุกรม (Series NO - AND Logic)',
    objective: 'เชื่อมต่อวงจรจากวงจรสัญลักษณ์: ต่อสวิตช์ S1 (NO) อนุกรมกับ S2 (NO) เพื่อควบคุมหลอดไฟ LOAD (L1) ที่แรงดัน 12VDC (หลอดไฟจะสว่างเมื่อกดทั้ง S1 และ S2 พร้อมกัน)',
    inputs: ['S1', 'S2'],
    outputs: ['L1'],
    showL2: false,
    showS2: true,
    showRelays: false,
    truthTable: [
      { S1: 0, S2: 0, expected: { L1: 0 } },
      { S1: 0, S2: 1, expected: { L1: 0 } },
      { S1: 1, S2: 0, expected: { L1: 0 } },
      { S1: 1, S2: 1, expected: { L1: 1 } }
    ],
    logicComparison: 'AND Gate (ลอจิกเกต AND)',
    hintWires: [
      {
        from: 'PWR_POS',
        to: 'S1_NO_1',
        color: '#ef4444',
        waypoints: [{ x: 115, y: 185 }, { x: 412, y: 185 }]
      },
      {
        from: 'S1_NO_2',
        to: 'S2_NO_1',
        color: '#ef4444',
        waypoints: [{ x: 445, y: 347 }, { x: 445, y: 468 }]
      },
      {
        from: 'S2_NO_2',
        to: 'L1_A',
        color: '#3b82f6',
        waypoints: [{ x: 520, y: 542 }, { x: 520, y: 106 }]
      },
      {
        from: 'L1_B',
        to: 'PWR_NEG',
        color: '#1e293b',
        waypoints: [{ x: 777, y: 18 }, { x: 190, y: 18 }, { x: 190, y: 173 }]
      }
    ]
  },

  lab1_2: {
    id: 'lab1_2',
    title: 'ใบงานที่ 1 (ตอนที่ 2): วงจรสวิตช์ขนาน NC (Parallel NC - NAND Logic)',
    objective: 'เชื่อมต่อวงจรจากวงจรสัญลักษณ์: ต่อสวิตช์ S1 (NC) ขนานกับ S2 (NC) เพื่อควบคุมหลอดไฟ LOAD (L1) ที่แรงดัน 12VDC (สภาวะปกติหลอดไฟจะติดสว่าง และจะดับก็ต่อเมื่อกดทั้ง S1 และ S2 พร้อมกัน)',
    inputs: ['S1', 'S2'],
    outputs: ['L1'],
    showL2: false,
    showS2: true,
    showRelays: false,
    truthTable: [
      { S1: 0, S2: 0, expected: { L1: 1 } },
      { S1: 0, S2: 1, expected: { L1: 1 } },
      { S1: 1, S2: 0, expected: { L1: 1 } },
      { S1: 1, S2: 1, expected: { L1: 0 } }
    ],
    logicComparison: 'NAND Gate (ลอจิกเกต NAND - ต่อหน้าสัมผัส NC ขนานกัน)',
    hintWires: [
      {
        from: 'PWR_POS',
        to: 'TB_1_T',
        color: '#ef4444',
        waypoints: [{ x: 115, y: 42 }, { x: 253, y: 42 }]
      },
      {
        from: 'TB_1_B',
        to: 'S1_NC_1',
        color: '#ef4444',
        waypoints: [{ x: 253, y: 195 }, { x: 340, y: 195 }]
      },
      {
        from: 'S1_NC_1',
        to: 'S2_NC_1',
        color: '#ef4444',
        waypoints: [{ x: 300, y: 263 }, { x: 300, y: 458 }]
      },
      {
        from: 'S1_NC_2',
        to: 'S2_NC_2',
        color: '#3b82f6',
        waypoints: [{ x: 375, y: 337 }, { x: 375, y: 532 }]
      },
      {
        from: 'S2_NC_2',
        to: 'L1_A',
        color: '#3b82f6',
        waypoints: [{ x: 340, y: 580 }, { x: 520, y: 580 }, { x: 520, y: 106 }]
      },
      {
        from: 'L1_B',
        to: 'PWR_NEG',
        color: '#1e293b',
        waypoints: [{ x: 777, y: 18 }, { x: 190, y: 18 }, { x: 190, y: 173 }]
      }
    ]
  },

  lab1_ex: {
    id: 'lab1_ex',
    title: 'ใบงานที่ 1 (แบบฝึกหัดท้ายใบงาน): วงจร NOR Logic (S1=0, S2=0 ได้ LOAD=1)',
    objective: 'ออกแบบและต่อวงจรให้ทำงานตามตารางความจริง: สภาวะปกติไม่ได้กดสวิตช์ (0,0) หลอดไฟติดสว่าง (1) แต่หากกดสวิตช์ตัวใดตัวหนึ่งหรือทั้งสองตัว หลอดไฟจะดับ (0) ด้วยการต่อหน้าสัมผัส NC ของ S1 และ S2 แบบอนุกรม',
    inputs: ['S1', 'S2'],
    outputs: ['L1'],
    showL2: false,
    showS2: true,
    showRelays: false,
    truthTable: [
      { S1: 0, S2: 0, expected: { L1: 1 } },
      { S1: 0, S2: 1, expected: { L1: 0 } },
      { S1: 1, S2: 0, expected: { L1: 0 } },
      { S1: 1, S2: 1, expected: { L1: 0 } }
    ],
    logicComparison: 'NOR Gate (ต่อหน้าสัมผัส NC อนุกรมกัน)',
    hintWires: [
      {
        from: 'PWR_POS',
        to: 'S1_NC_1',
        color: '#ef4444',
        waypoints: [{ x: 115, y: 195 }, { x: 340, y: 195 }]
      },
      {
        from: 'S1_NC_2',
        to: 'S2_NC_1',
        color: '#ef4444',
        waypoints: [{ x: 300, y: 347 }, { x: 300, y: 468 }]
      },
      {
        from: 'S2_NC_2',
        to: 'L1_A',
        color: '#3b82f6',
        waypoints: [{ x: 340, y: 585 }, { x: 520, y: 585 }, { x: 520, y: 106 }]
      },
      {
        from: 'L1_B',
        to: 'PWR_NEG',
        color: '#1e293b',
        waypoints: [{ x: 777, y: 18 }, { x: 190, y: 18 }, { x: 190, y: 173 }]
      }
    ]
  },

  lab2_1: {
    id: 'lab2_1',
    title: 'ใบงานที่ 2 (ข้อ 3-4): การต่อวงจรรีเลย์เบื้องต้นควบคุมหลอดไฟ 1 หลอด',
    objective: 'เชื่อมต่อวงจรรีเลย์ตามสัญลักษณ์: ใช้สวิตช์ S1 (NO) จ่ายไฟเข้าคอยล์รีเลย์ (ขา 13-14 ของ K1 หรือ K2) และใช้หน้าสัมผัส NO ของรีเลย์ (เช่น ขา 9 COM และ ขา 5 NO หรือ ขา 12 COM และ ขา 8 NO) ไปสั่งเปิดหลอดไฟ L1',
    inputs: ['S1'],
    outputs: ['L1'],
    requireRelay: true,
    showL2: false,
    showS2: false,
    showRelays: true,
    truthTable: [
      { S1: 0, expected: { L1: 0, RELAY: 0 } },
      { S1: 1, expected: { L1: 1, RELAY: 1 } }
    ],
    logicComparison: 'การแยกวงจรควบคุม (Control) และวงจรกำลัง (Load) ด้วย Relay',
    hintWires: [
      {
        from: 'PWR_POS',
        to: 'TB_1_T',
        color: '#ef4444',
        waypoints: [{ x: 115, y: 42 }, { x: 253, y: 42 }]
      },
      {
        from: 'TB_1_B',
        to: 'S1_NO_1',
        color: '#ef4444',
        waypoints: [{ x: 253, y: 195 }, { x: 412, y: 195 }]
      },
      {
        from: 'S1_NO_2',
        to: 'K2_14',
        color: '#3b82f6',
        waypoints: [{ x: 412, y: 560 }, { x: 714, y: 560 }]
      },
      {
        from: 'TB_1_B',
        to: 'K2_9',
        color: '#eab308',
        waypoints: [{ x: 253, y: 178 }, { x: 855, y: 178 }, { x: 855, y: 482 }]
      },
      {
        from: 'K2_5',
        to: 'L1_A',
        color: '#eab308',
        waypoints: [{ x: 796, y: 230 }, { x: 693, y: 230 }]
      },
      {
        from: 'L1_B',
        to: 'TB_6_T',
        color: '#1e293b',
        waypoints: [{ x: 777, y: 42 }, { x: 483, y: 42 }]
      },
      {
        from: 'K2_13',
        to: 'TB_6_B',
        color: '#1e293b',
        waypoints: [{ x: 755, y: 575 }, { x: 483, y: 575 }]
      },
      {
        from: 'TB_6_T',
        to: 'PWR_NEG',
        color: '#1e293b',
        waypoints: [{ x: 483, y: 22 }, { x: 190, y: 22 }, { x: 190, y: 173 }]
      }
    ]
  },

  lab2_2: {
    id: 'lab2_2',
    title: 'ใบงานที่ 2 (ข้อ 5-6): การต่อวงจรรีเลย์ควบคุมหลอดไฟ 2 หลอดสลับกัน (NO / NC)',
    objective: 'ต่อวงจรตามสัญลักษณ์โดยเพิ่มหลอดไฟเป็น 2 หลอด (L1, L2): สภาวะปกติยังไม่ได้กด S1 หลอดไฟ L2 สว่างผ่านหน้าสัมผัส NC ของรีเลย์ (ขา 9-1 หรือ 12-4) เมื่อกด S1 รีเลย์ทำงานจะสลับไปจ่ายไฟผ่านหน้าสัมผัส NO (ขา 9-5 หรือ 12-8) ทำให้ L1 สว่างและ L2 ดับ',
    inputs: ['S1'],
    outputs: ['L1', 'L2'],
    requireRelay: true,
    showL2: true,
    showS2: false,
    showRelays: true,
    truthTable: [
      { S1: 0, expected: { L1: 0, L2: 1, RELAY: 0 } },
      { S1: 1, expected: { L1: 1, L2: 0, RELAY: 1 } }
    ],
    logicComparison: 'การใช้หน้าสัมผัสเปลี่ยนทาง (Changeover Contact SPDT/DPDT: COM, NO, NC)',
    hintWires: [
      {
        from: 'PWR_POS',
        to: 'TB_1_T',
        color: '#ef4444',
        waypoints: [{ x: 115, y: 42 }, { x: 253, y: 42 }]
      },
      {
        from: 'TB_1_B',
        to: 'S1_NO_1',
        color: '#ef4444',
        waypoints: [{ x: 253, y: 195 }, { x: 412, y: 195 }]
      },
      {
        from: 'S1_NO_2',
        to: 'K1_14',
        color: '#3b82f6',
        waypoints: [{ x: 412, y: 558 }, { x: 569, y: 558 }]
      },
      {
        from: 'TB_1_B',
        to: 'K1_9',
        color: '#eab308',
        waypoints: [{ x: 253, y: 180 }, { x: 678, y: 180 }, { x: 678, y: 482 }]
      },
      {
        from: 'K1_5',
        to: 'L1_A',
        color: '#22c55e',
        waypoints: [{ x: 651, y: 106 }]
      },
      {
        from: 'K1_1',
        to: 'L2_A',
        color: '#eab308',
        waypoints: [{ x: 651, y: 196 }]
      },
      {
        from: 'L1_B',
        to: 'L2_B',
        color: '#1e293b',
        waypoints: [{ x: 825, y: 106 }, { x: 825, y: 196 }]
      },
      {
        from: 'L1_B',
        to: 'TB_6_T',
        color: '#1e293b',
        waypoints: [{ x: 777, y: 42 }, { x: 483, y: 42 }]
      },
      {
        from: 'K1_13',
        to: 'TB_6_B',
        color: '#1e293b',
        waypoints: [{ x: 610, y: 575 }, { x: 483, y: 575 }]
      },
      {
        from: 'TB_6_T',
        to: 'PWR_NEG',
        color: '#1e293b',
        waypoints: [{ x: 483, y: 22 }, { x: 190, y: 22 }, { x: 190, y: 173 }]
      }
    ]
  },

  lab2_latch: {
    id: 'lab2_latch',
    title: 'โจทย์เสริม: วงจรรีเลย์ค้างสถานะ (Self-Holding / Start-Stop Circuit)',
    objective: 'วงจรมาตรฐานงานควบคุมอุตสาหกรรม: กดปุ่ม S1 (NO - Start) เพียงครั้งเดียวแล้วปล่อย รีเลย์ K1 และหลอดไฟ L1 จะค้างสถานะติดสว่างต่อไป (ใช้หน้าสัมผัส NO ของ K1 ต่อขนานกับ S1) และจะดับเมื่อกดปุ่ม S2 (NC - Stop)',
    inputs: ['S1', 'S2'],
    outputs: ['L1'],
    requireRelay: true,
    isSequentialLatch: true,
    showL2: false,
    showS2: true,
    showRelays: true,
    truthTable: [
      { step: '1. สภาวะเริ่มต้น (ยังไม่กด)', S1: 0, S2: 0, expected: { L1: 0, RELAY: 0 } },
      { step: '2. กดปุ่ม Start (S1=1, S2=0)', S1: 1, S2: 0, expected: { L1: 1, RELAY: 1 } },
      { step: '3. ปล่อยปุ่ม Start (S1=0, S2=0) -> ค้างสถานะ', S1: 0, S2: 0, expected: { L1: 1, RELAY: 1 } },
      { step: '4. กดปุ่ม Stop (S1=0, S2=1) -> ตัดวงจร', S1: 0, S2: 1, expected: { L1: 0, RELAY: 0 } }
    ],
    logicComparison: 'วงจร Self-Holding (Latching Relay Circuit)',
    hintWires: [
      {
        from: 'PWR_POS',
        to: 'S2_NC_1',
        color: '#ef4444',
        waypoints: [{ x: 115, y: 468 }]
      },
      {
        from: 'S2_NC_2',
        to: 'S1_NO_1',
        color: '#ef4444',
        waypoints: [{ x: 340, y: 575 }, { x: 465, y: 575 }, { x: 465, y: 273 }]
      },
      {
        from: 'S1_NO_1',
        to: 'K1_9',
        color: '#eab308',
        waypoints: [{ x: 412, y: 205 }, { x: 678, y: 205 }, { x: 678, y: 482 }]
      },
      {
        from: 'S1_NO_2',
        to: 'K1_14',
        color: '#3b82f6',
        waypoints: [{ x: 510, y: 347 }, { x: 510, y: 522 }]
      },
      {
        from: 'K1_5',
        to: 'K1_14',
        color: '#eab308',
        waypoints: [{ x: 685, y: 322 }, { x: 685, y: 558 }, { x: 569, y: 558 }]
      },
      {
        from: 'K1_5',
        to: 'L1_A',
        color: '#22c55e',
        waypoints: [{ x: 651, y: 106 }]
      },
      {
        from: 'L1_B',
        to: 'TB_6_T',
        color: '#1e293b',
        waypoints: [{ x: 777, y: 42 }, { x: 483, y: 42 }]
      },
      {
        from: 'K1_13',
        to: 'TB_6_B',
        color: '#1e293b',
        waypoints: [{ x: 610, y: 580 }, { x: 483, y: 580 }]
      },
      {
        from: 'TB_6_T',
        to: 'PWR_NEG',
        color: '#1e293b',
        waypoints: [{ x: 483, y: 22 }, { x: 190, y: 22 }, { x: 190, y: 173 }]
      }
    ]
  }
};

// Initialize Workbench SVG Components (Terminal Block & Relays)
function initWorkbenchComponents() {
  // 1. Build 6x2 Terminal Block
  const tbContainer = document.getElementById('terminalBlockPins');
  tbContainer.innerHTML = '';
  for (let col = 1; col <= 6; col++) {
    const xCenter = (col - 1) * 46 + 23;
    if (col < 6) {
      const vLine = document.createElementNS(SVG_NS, 'line');
      vLine.setAttribute('x1', col * 46);
      vLine.setAttribute('y1', 0);
      vLine.setAttribute('x2', col * 46);
      vLine.setAttribute('y2', 96);
      vLine.setAttribute('stroke', '#1e293b');
      vLine.setAttribute('stroke-width', '2.5');
      tbContainer.appendChild(vLine);
    }
    // Internal connection trace indicator
    const linkLine = document.createElementNS(SVG_NS, 'line');
    linkLine.setAttribute('x1', xCenter);
    linkLine.setAttribute('y1', 24);
    linkLine.setAttribute('x2', xCenter);
    linkLine.setAttribute('y2', 72);
    linkLine.setAttribute('stroke', '#ca8a04');
    linkLine.setAttribute('stroke-width', '2');
    linkLine.setAttribute('stroke-dasharray', '2 2');
    tbContainer.appendChild(linkLine);

    // Horizontal middle divider
    const hLine = document.createElementNS(SVG_NS, 'line');
    hLine.setAttribute('x1', 0);
    hLine.setAttribute('y1', 48);
    hLine.setAttribute('x2', 276);
    hLine.setAttribute('y2', 48);
    hLine.setAttribute('stroke', '#1e293b');
    hLine.setAttribute('stroke-width', '2.5');
    tbContainer.appendChild(hLine);

    // Top & Bottom screws
    const rows = [
      { suffix: 'T', y: 24, label: `ขั้วต่อสายร่วมช่องที่ ${col} (บน)` },
      { suffix: 'B', y: 72, label: `ขั้วต่อสายร่วมช่องที่ ${col} (ล่าง)` }
    ];
    rows.forEach((r) => {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'terminal-node');
      g.setAttribute('data-terminal', `TB_${col}_${r.suffix}`);
      g.setAttribute('data-label', r.label);
      g.setAttribute('transform', `translate(${xCenter}, ${r.y})`);
      g.innerHTML = `
        <circle class="term-hit" r="18" fill="transparent" />
        <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
        <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
      `;
      tbContainer.appendChild(g);
    });
  }

  // 2. Build Relay Sockets K1 & K2 (MY2N-J exact layout from Doc2)
  renderRelaySocket('relayK1Container', 'K1');
  renderRelaySocket('relayK2Container', 'K2');
}

function renderRelaySocket(containerId, prefix) {
  const container = document.getElementById(containerId);
  const pins = [
    { num: '4', x: 65, y: 24, desc: `${prefix} ขา 4 (NC ชุดที่ 2 - คู่กับขา 12)` },
    { num: '1', x: 106, y: 24, desc: `${prefix} ขา 1 (NC ชุดที่ 1 - คู่กับขา 9)` },
    { num: '8', x: 24, y: 62, desc: `${prefix} ขา 8 (NO ชุดที่ 2 - คู่กับขา 12)` },
    { num: '5', x: 106, y: 62, desc: `${prefix} ขา 5 (NO ชุดที่ 1 - คู่กับขา 9)` },
    { num: '12', x: 24, y: 222, desc: `${prefix} ขา 12 (COM ชุดที่ 2)` },
    { num: '9', x: 106, y: 222, desc: `${prefix} ขา 9 (COM ชุดที่ 1)` },
    { num: '14', x: 24, y: 262, desc: `${prefix} ขา 14 (Coil +)` },
    { num: '13', x: 65, y: 262, desc: `${prefix} ขา 13 (Coil -)` }
  ];

  let html = `
    <rect x="0" y="0" width="130" height="288" rx="4" fill="#1e293b" stroke="#0f172a" stroke-width="2" />
    <!-- Top Socket Grid -->
    <rect x="6" y="6" width="118" height="76" fill="#94a3b8" />
    <rect x="46" y="8" width="38" height="36" fill="#334155" />
    <rect x="86" y="8" width="36" height="36" fill="#334155" />
    <rect x="8" y="45" width="37" height="35" fill="#334155" />
    <rect x="86" y="45" width="36" height="35" fill="#334155" />

    <!-- Center Body MY2N-J -->
    <rect x="6" y="86" width="118" height="112" fill="#f1f5f9" stroke="#334155" stroke-width="1.5" />
    <text x="72" y="122" text-anchor="middle" fill="#0f172a" font-size="16" font-weight="700">RELAY</text>
    <text x="72" y="144" text-anchor="middle" fill="#0f172a" font-size="15" font-weight="600">MY2N-J</text>
    <circle id="${prefix}_ledHalo" cx="34" cy="172" r="14" fill="#4ade80" opacity="0" filter="url(#glow-green)" />
    <circle id="${prefix}_led" cx="34" cy="172" r="10" fill="#065f46" stroke="#1e293b" stroke-width="1.5" />
    <text x="84" y="179" text-anchor="middle" fill="#0f172a" font-size="22" font-weight="700">${prefix}</text>

    <!-- Bottom Socket Grid -->
    <rect x="6" y="202" width="118" height="80" fill="#94a3b8" />
    <rect x="8" y="204" width="37" height="37" fill="#334155" />
    <rect x="86" y="204" width="36" height="37" fill="#334155" />
    <rect x="8" y="242" width="37" height="38" fill="#334155" />
    <rect x="46" y="242" width="38" height="38" fill="#334155" />
  `;

  pins.forEach((p) => {
    html += `
      <text x="${p.x + 13}" y="${p.y - 7}" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="700">${p.num}</text>
      <g class="terminal-node" data-terminal="${prefix}_${p.num}" data-label="${p.desc}" transform="translate(${p.x}, ${p.y})">
        <circle class="term-hit" r="18" fill="transparent" />
        <circle class="term-screw" r="11" fill="url(#screwGrad)" stroke="#0f172a" stroke-width="1.8" />
        <path d="M-6,0 H6 M0,-6 V6" stroke="#1e293b" stroke-width="2" />
      </g>
    `;
  });

  container.innerHTML = html;
}

// Get exact SVG coordinates (in 920x620 viewBox space) of any terminal
function getTerminalPosition(termId) {
  const svg = document.getElementById('workbenchSvg');
  const node = svg.querySelector(`.terminal-node[data-terminal="${termId}"]`);
  if (!node) return { x: 0, y: 0 };

  const ctm = node.getCTM();
  const svgCTM = svg.getCTM();
  if (!ctm || !svgCTM) return { x: 0, y: 0 };

  const pt = svg.createSVGPoint();
  pt.x = 0;
  pt.y = 0;
  const transformed = pt.matrixTransform(svgCTM.inverse().multiply(ctm));
  return { x: transformed.x, y: transformed.y };
}

// Convert client mouse/touch coordinates to SVG viewBox coordinates
function clientToSvgPoint(clientX, clientY) {
  const svg = document.getElementById('workbenchSvg');
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  return pt.matrixTransform(ctm.inverse());
}

// Magnetic Snap-In Radius (in SVG viewBox units) so dragging near a pin automatically locks onto it
const MAGNETIC_SNAP_RADIUS = 36;
const TAP_SNAP_RADIUS = 28;

function findNearestSnapTerminal(svgPt, excludeTermId = null, maxDist = MAGNETIC_SNAP_RADIUS) {
  const svg = document.getElementById('workbenchSvg');
  if (!svg || !svgPt) return null;

  const nodes = svg.querySelectorAll('.terminal-node');
  let best = null;
  let minDist = maxDist;

  nodes.forEach((node) => {
    const termId = node.getAttribute('data-terminal');
    if (!termId || termId === excludeTermId) return;
    const pos = getTerminalPosition(termId);
    const dist = Math.hypot(pos.x - svgPt.x, pos.y - svgPt.y);
    if (dist <= minDist) {
      minDist = dist;
      best = {
        termId,
        label: node.getAttribute('data-label') || termId,
        node,
        pos,
        dist
      };
    }
  });

  return best;
}

function updateSnapIndicator(snapTarget) {
  const snapEl = document.getElementById('snapTargetIndicator');
  const outerRing = document.getElementById('snapRingOuter');
  const innerRing = document.getElementById('snapRingInner');

  document.querySelectorAll('.terminal-node.snap-target-active').forEach((el) => {
    el.classList.remove('snap-target-active');
  });

  if (!snapEl || !outerRing || !innerRing) return;

  if (snapTarget) {
    outerRing.setAttribute('cx', snapTarget.pos.x.toFixed(1));
    outerRing.setAttribute('cy', snapTarget.pos.y.toFixed(1));
    innerRing.setAttribute('cx', snapTarget.pos.x.toFixed(1));
    innerRing.setAttribute('cy', snapTarget.pos.y.toFixed(1));
    snapEl.setAttribute('opacity', '1');
    if (snapTarget.node) {
      snapTarget.node.classList.add('snap-target-active');
    }
  } else {
    snapEl.setAttribute('opacity', '0');
  }
}

function pointToSegmentDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

// Compute wire path supporting intermediate waypoints (rounded corners), custom dragged bendPoint, or default curve
function computeWirePath(p1, p2, waypoints = [], bendPoint = null) {
  if (waypoints && waypoints.length > 0) {
    const pts = [p1, ...waypoints, p2];
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;

    for (let i = 1; i < pts.length - 1; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const next = pts[i + 1];

      const v1x = curr.x - prev.x;
      const v1y = curr.y - prev.y;
      const len1 = Math.hypot(v1x, v1y);

      const v2x = next.x - curr.x;
      const v2y = next.y - curr.y;
      const len2 = Math.hypot(v2x, v2y);

      const r = Math.min(22, len1 * 0.4, len2 * 0.4);
      if (r > 2) {
        const startX = curr.x - (v1x / len1) * r;
        const startY = curr.y - (v1y / len1) * r;
        const endX = curr.x + (v2x / len2) * r;
        const endY = curr.y + (v2y / len2) * r;
        d += ` L ${startX.toFixed(1)} ${startY.toFixed(1)} Q ${curr.x.toFixed(1)} ${curr.y.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`;
      } else {
        d += ` L ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
      }
    }

    const last = pts[pts.length - 1];
    d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
    return d;
  }

  // If user dragged/bent this wire, curve smoothly right through bendPoint while keeping p1 & p2 fixed!
  if (bendPoint) {
    const cx = 2 * bendPoint.x - 0.5 * (p1.x + p2.x);
    const cy = 2 * bendPoint.y - 0.5 * (p1.y + p2.y);
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.hypot(dx, dy);
  const sag = Math.min(48, Math.max(14, dist * 0.16));
  const cx1 = p1.x + dx * 0.25;
  const cy1 = p1.y + dy * 0.25 + sag;
  const cx2 = p1.x + dx * 0.75;
  const cy2 = p1.y + dy * 0.75 + sag;
  return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${cx1.toFixed(1)} ${cy1.toFixed(1)}, ${cx2.toFixed(1)} ${cy2.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
}

// Physics / Graph Solver for Electrical Simulation
function evaluateCircuit(customInputs = null, prevRelayState = { K1: false, K2: false }) {
  const s1Pressed = customInputs ? Boolean(customInputs.S1) : state.switches.S1.pressed;
  const s2Pressed = customInputs ? Boolean(customInputs.S2) : state.switches.S2.pressed;
  const powerActive = customInputs ? true : state.powerOn;

  let k1Active = prevRelayState.K1 || false;
  let k2Active = prevRelayState.K2 || false;

  let posSet = new Set();
  let negSet = new Set();

  for (let iter = 0; iter < 5; iter++) {
    const adj = new Map();
    const addEdge = (a, b) => {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b);
      adj.get(b).push(a);
    };

    // 1. User wires
    for (const w of state.wires) {
      addEdge(w.from, w.to);
    }

    // 2. Terminal Block internal vertical connections (TB_1..6_T <-> TB_1..6_B)
    for (let c = 1; c <= 6; c++) {
      addEdge(`TB_${c}_T`, `TB_${c}_B`);
    }

    // 3. Pushbutton Switches S1 & S2 internal contacts
    if (s1Pressed) {
      addEdge('S1_NO_1', 'S1_NO_2');
    } else {
      addEdge('S1_NC_1', 'S1_NC_2');
    }

    if (s2Pressed) {
      addEdge('S2_NO_1', 'S2_NO_2');
    } else {
      addEdge('S2_NC_1', 'S2_NC_2');
    }

    // 4. Relay K1 & K2 internal contacts (MY2N-J: COM1=9, NC1=1, NO1=5 | COM2=12, NC2=4, NO2=8)
    if (k1Active) {
      addEdge('K1_9', 'K1_5');
      addEdge('K1_12', 'K1_8');
    } else {
      addEdge('K1_9', 'K1_1');
      addEdge('K1_12', 'K1_4');
    }

    if (k2Active) {
      addEdge('K2_9', 'K2_5');
      addEdge('K2_12', 'K2_8');
    } else {
      addEdge('K2_9', 'K2_1');
      addEdge('K2_12', 'K2_4');
    }

    // BFS from PWR_POS and PWR_NEG
    posSet = new Set();
    negSet = new Set();

    if (powerActive) {
      const qPos = ['PWR_POS'];
      posSet.add('PWR_POS');
      while (qPos.length > 0) {
        const curr = qPos.shift();
        for (const nxt of adj.get(curr) || []) {
          if (!posSet.has(nxt)) {
            posSet.add(nxt);
            qPos.push(nxt);
          }
        }
      }

      const qNeg = ['PWR_NEG'];
      negSet.add('PWR_NEG');
      while (qNeg.length > 0) {
        const curr = qNeg.shift();
        for (const nxt of adj.get(curr) || []) {
          if (!negSet.has(nxt)) {
            negSet.add(nxt);
            qNeg.push(nxt);
          }
        }
      }
    }

    const short = powerActive && posSet.has('PWR_NEG');
    if (short) {
      return {
        shortCircuit: true,
        L1: false,
        L2: false,
        K1: false,
        K2: false,
        posTerminals: posSet,
        negTerminals: negSet
      };
    }

    const isComponentEnergized = (pinA, pinB) =>
      (posSet.has(pinA) && negSet.has(pinB)) || (posSet.has(pinB) && negSet.has(pinA));

    const nextK1 = isComponentEnergized('K1_13', 'K1_14');
    const nextK2 = isComponentEnergized('K2_13', 'K2_14');

    if (nextK1 === k1Active && nextK2 === k2Active) {
      break;
    }
    k1Active = nextK1;
    k2Active = nextK2;
  }

  const isEnergized = (pinA, pinB) =>
    (posSet.has(pinA) && negSet.has(pinB)) || (posSet.has(pinB) && negSet.has(pinA));

  return {
    shortCircuit: false,
    L1: isEnergized('L1_A', 'L1_B'),
    L2: isEnergized('L2_A', 'L2_B'),
    K1: k1Active,
    K2: k2Active,
    posTerminals: posSet,
    negTerminals: negSet
  };
}

// Update visual state of workbench, wires, lamps, relays, and schematic
function updateSimulationUI() {
  const prevRelays = { K1: state.simResult.K1, K2: state.simResult.K2 };
  const res = evaluateCircuit(null, prevRelays);
  state.simResult = res;

  // Short circuit indicator
  const shortAlert = document.getElementById('shortCircuitAlert');
  shortAlert.setAttribute('opacity', res.shortCircuit ? '1' : '0');

  // Update Lamp L1 & L2
  const lamp1Body = document.getElementById('lamp1Body');
  const lamp1Halo = document.getElementById('lamp1Halo');
  lamp1Body.setAttribute('fill', res.L1 ? 'url(#lampOnGrad)' : 'url(#lampOffGrad)');
  lamp1Halo.setAttribute('opacity', res.L1 ? '0.95' : '0');

  const lamp2Body = document.getElementById('lamp2Body');
  const lamp2Halo = document.getElementById('lamp2Halo');
  lamp2Body.setAttribute('fill', res.L2 ? 'url(#lampOnGrad)' : 'url(#lampOffGrad)');
  lamp2Halo.setAttribute('opacity', res.L2 ? '0.95' : '0');

  // Update Relay K1 & K2 LEDs
  ['K1', 'K2'].forEach((k) => {
    const active = res[k];
    const led = document.getElementById(`${k}_led`);
    const halo = document.getElementById(`${k}_ledHalo`);
    if (led && halo) {
      led.setAttribute('fill', active ? '#22c55e' : '#065f46');
      halo.setAttribute('opacity', active ? '0.9' : '0');
    }
  });

  // Update Switches S1 & S2 visual plunger & internal mechanical bridge
  ['S1', 'S2'].forEach((sw, idx) => {
    const num = idx + 1;
    const pressed = state.switches[sw].pressed;
    const cap = document.getElementById(`s${num}Cap`);
    const ncBridge = document.getElementById(`s${num}NcBridge`);
    const noBridge = document.getElementById(`s${num}NoBridge`);
    const stateText = document.getElementById(`s${num}StateText`);
    const statePill = document.getElementById(`s${num}StatePill`);

    cap.setAttribute('x', pressed ? '10' : '0');
    cap.setAttribute('fill', pressed ? '#059669' : '#10b981');

    if (pressed) {
      ncBridge.setAttribute('stroke', '#94a3b8');
      ncBridge.setAttribute('opacity', '0.35');
      noBridge.setAttribute('stroke', '#16a34a');
      noBridge.setAttribute('stroke-width', '3.5');
      noBridge.setAttribute('opacity', '1');
      if (stateText) stateText.textContent = 'กดค้าง ON (1)';
      if (statePill) statePill.setAttribute('fill', '#dcfce7');
      if (stateText) stateText.setAttribute('fill', '#15803d');
    } else {
      ncBridge.setAttribute('stroke', '#16a34a');
      ncBridge.setAttribute('opacity', '1');
      noBridge.setAttribute('stroke', '#94a3b8');
      noBridge.setAttribute('stroke-width', '2');
      noBridge.setAttribute('opacity', '0.4');
      if (stateText) stateText.textContent = 'ปกติ OFF (0)';
      if (statePill) statePill.setAttribute('fill', '#e2e8f0');
      if (stateText) stateText.setAttribute('fill', '#334155');
    }
  });

  // Update toolbar switch mode button
  const modeBtn = document.getElementById('btnSwitchModeToggle');
  if (modeBtn) {
    const isLocked = state.switches.S1.locked;
    modeBtn.classList.toggle('locked', isLocked);
    modeBtn.classList.toggle('momentary', !isLocked);
    modeBtn.textContent = isLocked
      ? '🔒 กดค้างสถานะ (คลิกสลับ)'
      : '🔓 กดติดปล่อยดับ (Momentary)';
  }

  // Update Undo / Redo button states
  updateUndoRedoUI();

  // Highlight energized terminals
  document.querySelectorAll('.terminal-node').forEach((node) => {
    const termId = node.getAttribute('data-terminal');
    node.classList.toggle('energized-pos', res.posTerminals.has(termId));
    node.classList.toggle('energized-neg', !res.posTerminals.has(termId) && res.negTerminals.has(termId));
    node.classList.toggle('selected-terminal', state.selectedTerminal === termId);
  });

  // Render wires
  renderWires();

  // Render live interactive schematic on the left panel
  renderSchematic();

  // Highlight active row in truth table
  highlightActiveTruthRow();
}

function renderWires() {
  const layer = document.getElementById('wiresLayer');
  layer.innerHTML = '';

  const lab = LABS[state.currentLabId];
  if (state.showingHints && lab && lab.hintWires) {
    lab.hintWires.forEach((hw) => {
      const p1 = getTerminalPosition(hw.from);
      const p2 = getTerminalPosition(hw.to);
      const d = computeWirePath(p1, p2, hw.waypoints || []);
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'wire-group hint-wire');
      g.innerHTML = `<path class="wire-path" d="${d}" stroke="${hw.color}" />`;
      layer.appendChild(g);
    });
  }

  state.wires.forEach((w) => {
    const p1 = getTerminalPosition(w.from);
    const p2 = getTerminalPosition(w.to);
    const waypoints = w.waypoints || [];
    const d = computeWirePath(p1, p2, waypoints, w.bendPoint || null);
    const isHot = state.simResult.posTerminals.has(w.from) || state.simResult.posTerminals.has(w.to);
    const isBending = state.bendingWire && state.bendingWire.wireId === w.id && state.bendingWire.hasMoved;

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `wire-group ${isHot ? 'hot-wire' : ''} ${isBending ? 'bending-wire' : ''}`);
    g.setAttribute('data-wire-id', w.id);

    let waypointDots = '';
    waypoints.forEach((wp, idx) => {
      waypointDots += `<circle class="wire-waypoint" data-wp-index="${idx}" cx="${wp.x.toFixed(1)}" cy="${wp.y.toFixed(1)}" r="5" fill="${w.color}" stroke="#ffffff" stroke-width="1.8" />`;
    });

    if (waypoints.length === 0 && w.bendPoint) {
      waypointDots += `<circle class="wire-waypoint wire-bend-handle" cx="${w.bendPoint.x.toFixed(1)}" cy="${w.bendPoint.y.toFixed(1)}" r="5.5" fill="${w.color}" stroke="#ffffff" stroke-width="2" />`;
    }

    g.innerHTML = `
      <title>กดค้างแล้วลากเพื่อดัดโค้งสายไฟ / คลิก 1 ครั้งเพื่อลบสาย (${w.from} ↔ ${w.to})</title>
      <path class="wire-hit" d="${d}" />
      <path class="wire-path" d="${d}" stroke="${w.color}" />
      <path class="wire-flow-overlay" d="${d}" />
      ${waypointDots}
    `;
    layer.appendChild(g);
  });

  // Render active waypoints while routing a wire
  if (state.selectedTerminal && state.activeWaypoints.length > 0) {
    state.activeWaypoints.forEach((wp) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', wp.x.toFixed(1));
      c.setAttribute('cy', wp.y.toFixed(1));
      c.setAttribute('r', '5');
      c.setAttribute('fill', state.wireColor);
      c.setAttribute('stroke', '#ffffff');
      c.setAttribute('stroke-width', '2');
      c.setAttribute('pointer-events', 'none');
      layer.appendChild(c);
    });
  }

  // Update mobile/desktop floating routing helper bar
  const helperBar = document.getElementById('routingHelperBar');
  const statusText = document.getElementById('routingStatusText');
  const undoWpBtn = document.getElementById('btnUndoWaypoint');
  if (helperBar && statusText) {
    if (state.selectedTerminal) {
      const termNode = document.querySelector(`.terminal-node[data-terminal="${state.selectedTerminal}"]`);
      const label = termNode ? termNode.getAttribute('data-label') : state.selectedTerminal;
      helperBar.hidden = false;
      statusText.textContent = `กำลังต่อสายจาก: ${label} (จุดพัก: ${state.activeWaypoints.length})`;
      if (undoWpBtn) {
        undoWpBtn.style.display = state.activeWaypoints.length > 0 ? 'inline-block' : 'none';
      }
    } else {
      helperBar.hidden = true;
    }
  }

  document.getElementById('wireCountText').textContent = `สายไฟที่ต่อ: ${state.wires.length} เส้น`;
}

// ============================================================================
// Academic Standard IEC 60617 SVG Symbol Helpers for Schematic Diagrams
// ============================================================================

/**
 * วาดสัญลักษณ์สวิตช์ปุ่มกด NO (Normally Open / Make Contact - IEC 60617)
 * - ขั้วบนอยู่ที่ (x, yTop) และขั้วล่างอยู่ที่ (x, yTop + 34)
 * - สภาวะปกติ (pressed=false): ใบสวิตช์เฉียงเปิดไปทางซ้าย (x - 14, yTop + 4) ไม่แตะขั้วบน
 *   ก้านปุ่มกด `[--` ดันจากซ้ายไปขวา เมื่อกด (pressed=true) ใบสวิตช์จะถูกผลักมาทางขวาแตะขั้วบนที่ (x, yTop)
 */
function drawIECSwitchNO({ id, label, x, yTop, pressed, topEnergized, bottomEnergized }) {
  const yBot = yTop + 34;
  const bladeTopX = pressed ? x : x - 14;
  const bladeTopY = pressed ? yTop : yTop + 4;
  const midX = (x + bladeTopX) / 2;
  const midY = (yBot + bladeTopY) / 2;
  const pushX = pressed ? x - 20 : x - 26;
  const strokeColor = bottomEnergized ? '#ef4444' : topEnergized ? '#ef4444' : '#475569';

  return `
    <g class="schem-sw" data-sw="${id}" style="cursor:pointer">
      <title>คลิกเพื่อกด/ปล่อยสวิตช์ ${label} (NO - ปกติเปิด)</title>
      <rect x="${x - 65}" y="${yTop - 8}" width="90" height="50" fill="transparent"/>
      <text x="${x - 58}" y="${yTop + 22}" font-size="13" font-weight="700" fill="#0f172a">${label}</text>
      <!-- ขั้วต่อบน-ล่าง (IEC Terminal Circles) -->
      <circle cx="${x}" cy="${yTop}" r="3.2" fill="#ffffff" stroke="${topEnergized ? '#ef4444' : '#334155'}" stroke-width="2"/>
      <circle cx="${x}" cy="${yBot}" r="3.2" fill="#ffffff" stroke="${bottomEnergized ? '#ef4444' : '#334155'}" stroke-width="2"/>
      <!-- ก้านปุ่มกดและเส้นประเชื่อมกลไก (Mechanical Linkage) -->
      <path d="M ${pushX + 6} ${midY - 9} H ${pushX} V ${midY + 9} H ${pushX + 6}" fill="none" stroke="#1e293b" stroke-width="2"/>
      <line x1="${pushX}" y1="${midY}" x2="${midX}" y2="${midY}" stroke="#475569" stroke-width="1.6" stroke-dasharray="3 2"/>
      <!-- ใบหน้าสัมผัสเคลื่อนที่ (Moving Contact Blade) -->
      <line x1="${x}" y1="${yBot - 3}" x2="${bladeTopX}" y2="${bladeTopY}" stroke="${strokeColor}" stroke-width="3" stroke-linecap="round"/>
    </g>
  `;
}

/**
 * วาดสัญลักษณ์สวิตช์ปุ่มกด NC (Normally Closed / Break Contact - IEC 60617)
 * - ขั้วบนมีบ่าขวางไปทางขวาจาก (x, yTop) ถึง (x + 12, yTop)
 * - สภาวะปกติ (pressed=false): ใบสวิตช์อยู่ทางขวาของบ่าขั้วบน แตะค้างที่ (x + 8, yTop) กระแสไหลผ่านได้
 * - เมื่อกดปุ่มจากซ้ายไปขวา (pressed=true): ก้านกดจะดันใบสวิตช์ไปทางขวาให้พ้นบ่าขั้วบนไปที่ (x + 19, yTop + 5) วงจรจึงเปิดออกตามหลักกลศาสตร์จริง
 */
function drawIECSwitchNC({ id, label, x, yTop, pressed, topEnergized, bottomEnergized }) {
  const yBot = yTop + 34;
  const bladeTopX = pressed ? x + 19 : x + 8;
  const bladeTopY = pressed ? yTop + 5 : yTop;
  const midX = (x + bladeTopX) / 2;
  const midY = (yBot + bladeTopY) / 2;
  const pushX = pressed ? x - 16 : x - 24;
  const strokeColor = bottomEnergized ? '#ef4444' : topEnergized ? '#ef4444' : '#475569';

  return `
    <g class="schem-sw" data-sw="${id}" style="cursor:pointer">
      <title>คลิกเพื่อกด/ปล่อยสวิตช์ ${label} (NC - ปกติปิด)</title>
      <rect x="${x - 65}" y="${yTop - 8}" width="95" height="50" fill="transparent"/>
      <text x="${x - 58}" y="${yTop + 22}" font-size="13" font-weight="700" fill="#0f172a">${label}</text>
      <!-- บ่าขั้วสัมผัส NC ด้านบน (Fixed Break Contact Bar) -->
      <path d="M ${x} ${yTop} H ${x + 11} V ${yTop + 4}" fill="none" stroke="${topEnergized ? '#ef4444' : '#1e293b'}" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="${x}" cy="${yTop}" r="3.2" fill="#ffffff" stroke="${topEnergized ? '#ef4444' : '#334155'}" stroke-width="2"/>
      <circle cx="${x}" cy="${yBot}" r="3.2" fill="#ffffff" stroke="${bottomEnergized ? '#ef4444' : '#334155'}" stroke-width="2"/>
      <!-- ก้านปุ่มกดและเส้นประเชื่อมกลไก -->
      <path d="M ${pushX + 6} ${midY - 9} H ${pushX} V ${midY + 9} H ${pushX + 6}" fill="none" stroke="#1e293b" stroke-width="2"/>
      <line x1="${pushX}" y1="${midY}" x2="${midX}" y2="${midY}" stroke="#475569" stroke-width="1.6" stroke-dasharray="3 2"/>
      <!-- ใบหน้าสัมผัส NC (วางฝั่งขวาของบ่า เมื่อกดจากซ้ายไปขวาจะผลักออกจากการสัมผัส) -->
      <line x1="${x}" y1="${yBot - 3}" x2="${bladeTopX}" y2="${bladeTopY}" stroke="${strokeColor}" stroke-width="3" stroke-linecap="round"/>
    </g>
  `;
}

// Render Dynamic Schematic Diagram based on current lab & live simulation state
function renderSchematic() {
  const container = document.getElementById('schematicContainer');
  const s1 = state.switches.S1.pressed;
  const s2 = state.switches.S2.pressed;
  const l1 = state.simResult.L1;
  const l2 = state.simResult.L2;
  const relayOn = state.simResult.K1 || state.simResult.K2;

  const hotStroke = '#ef4444';
  const gndStroke = '#3b82f6';
  const idleStroke = '#475569';

  let svgContent = '';

  if (state.currentLabId === 'lab1_1') {
    // Series S1 (NO) and S2 (NO) -> L1
    const mid1Hot = s1;
    const mid2Hot = s1 && s2;
    svgContent = `
      <svg viewBox="0 0 360 255">
        <text x="35" y="25" font-size="14" font-weight="700" fill="#dc2626">+12V</text>
        <circle cx="50" cy="38" r="6" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
        <path d="M56 38 H200 V62" fill="none" stroke="${hotStroke}" stroke-width="3"/>

        ${drawIECSwitchNO({
          id: 'S1',
          label: 'S1',
          x: 200,
          yTop: 62,
          pressed: s1,
          topEnergized: true,
          bottomEnergized: mid1Hot
        })}

        <path d="M200 96 V126" fill="none" stroke="${mid1Hot ? hotStroke : idleStroke}" stroke-width="3"/>

        ${drawIECSwitchNO({
          id: 'S2',
          label: 'S2',
          x: 200,
          yTop: 126,
          pressed: s2,
          topEnergized: mid1Hot,
          bottomEnergized: mid2Hot
        })}

        <path d="M200 160 V182" fill="none" stroke="${mid2Hot ? hotStroke : idleStroke}" stroke-width="3"/>

        <!-- Lamp LOAD -->
        <circle cx="200" cy="198" r="16" fill="${l1 ? '#fde047' : '#ffffff'}" stroke="#0f172a" stroke-width="2.5"/>
        <path d="M189 187 L211 209 M211 187 L189 209" stroke="#0f172a" stroke-width="2"/>
        <text x="235" y="203" font-size="13" font-weight="700" fill="#0f172a">LOAD (L1)</text>

        <path d="M200 214 V234 H56" fill="none" stroke="${gndStroke}" stroke-width="3"/>
        <circle cx="50" cy="234" r="6" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>
        <text x="38" y="222" font-size="14" font-weight="700" fill="#0f172a">0V</text>
      </svg>
    `;
  } else if (state.currentLabId === 'lab1_2') {
    // Parallel S1 (NC) and S2 (NC) -> L1 (Matches worksheet diagram)
    const branchHot = !s1 || !s2;
    svgContent = `
      <svg viewBox="0 0 360 255">
        <text x="25" y="24" font-size="14" font-weight="700" fill="#dc2626">+12V</text>
        <circle cx="45" cy="38" r="6" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
        <path d="M51 38 H280 V76 M150 38 V76" fill="none" stroke="${hotStroke}" stroke-width="3"/>
        <circle cx="150" cy="38" r="5" fill="#0f172a"/>

        ${drawIECSwitchNC({
          id: 'S1',
          label: 'S1',
          x: 150,
          yTop: 76,
          pressed: s1,
          topEnergized: true,
          bottomEnergized: !s1
        })}

        ${drawIECSwitchNC({
          id: 'S2',
          label: 'S2',
          x: 280,
          yTop: 76,
          pressed: s2,
          topEnergized: true,
          bottomEnergized: !s2
        })}

        <path d="M150 110 V145 M280 110 V145 H150 V168" fill="none" stroke="${branchHot ? hotStroke : idleStroke}" stroke-width="3"/>
        <circle cx="150" cy="145" r="5" fill="#0f172a"/>

        <circle cx="150" cy="184" r="16" fill="${l1 ? '#fde047' : '#ffffff'}" stroke="#0f172a" stroke-width="2.5"/>
        <path d="M139 173 L161 195 M161 173 L139 195" stroke="#0f172a" stroke-width="2"/>
        <text x="185" y="189" font-size="13" font-weight="700" fill="#0f172a">LOAD (L1)</text>

        <path d="M150 200 V232 H51" fill="none" stroke="${gndStroke}" stroke-width="3"/>
        <circle cx="45" cy="232" r="6" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>
        <text x="32" y="220" font-size="14" font-weight="700" fill="#0f172a">0V</text>
      </svg>
    `;
  } else if (state.currentLabId === 'lab1_ex') {
    // NOR Logic: S1 (NC) in series with S2 (NC) -> L1
    const mid1Hot = !s1;
    const mid2Hot = !s1 && !s2;
    svgContent = `
      <svg viewBox="0 0 360 255">
        <text x="35" y="25" font-size="14" font-weight="700" fill="#dc2626">+12V</text>
        <circle cx="50" cy="38" r="6" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
        <path d="M56 38 H200 V62" fill="none" stroke="${hotStroke}" stroke-width="3"/>

        ${drawIECSwitchNC({
          id: 'S1',
          label: 'S1',
          x: 200,
          yTop: 62,
          pressed: s1,
          topEnergized: true,
          bottomEnergized: mid1Hot
        })}

        <path d="M200 96 V126" fill="none" stroke="${mid1Hot ? hotStroke : idleStroke}" stroke-width="3"/>

        ${drawIECSwitchNC({
          id: 'S2',
          label: 'S2',
          x: 200,
          yTop: 126,
          pressed: s2,
          topEnergized: mid1Hot,
          bottomEnergized: mid2Hot
        })}

        <path d="M200 160 V182" fill="none" stroke="${mid2Hot ? hotStroke : idleStroke}" stroke-width="3"/>

        <circle cx="200" cy="198" r="16" fill="${l1 ? '#fde047' : '#ffffff'}" stroke="#0f172a" stroke-width="2.5"/>
        <path d="M189 187 L211 209 M211 187 L189 209" stroke="#0f172a" stroke-width="2"/>
        <text x="235" y="203" font-size="13" font-weight="700" fill="#0f172a">LOAD (L1)</text>

        <path d="M200 214 V234 H56" fill="none" stroke="${gndStroke}" stroke-width="3"/>
        <circle cx="50" cy="234" r="6" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>
        <text x="38" y="222" font-size="14" font-weight="700" fill="#0f172a">0V</text>
      </svg>
    `;
  } else if (state.currentLabId === 'lab2_1') {
    // Relay Basic Circuit (Matches Doc2 image4 with accurate IEC symbols)
    svgContent = `
      <svg viewBox="0 0 360 255">
        <text x="20" y="22" font-size="13" font-weight="700" fill="#dc2626">+12V</text>
        <circle cx="40" cy="36" r="5" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
        <path d="M45 36 H265 V76 M140 36 V76" fill="none" stroke="${hotStroke}" stroke-width="2.8"/>
        <circle cx="140" cy="36" r="4.5" fill="#0f172a"/>

        ${drawIECSwitchNO({
          id: 'S1',
          label: 'S1',
          x: 140,
          yTop: 76,
          pressed: s1,
          topEnergized: true,
          bottomEnergized: s1
        })}

        <path d="M140 110 V168" fill="none" stroke="${s1 ? hotStroke : idleStroke}" stroke-width="2.8"/>

        <!-- Relay Coil K -->
        <rect x="118" y="168" width="44" height="24" fill="${relayOn ? '#dcfce7' : '#ffffff'}" stroke="#0f172a" stroke-width="2.2"/>
        <text x="98" y="185" font-size="13" font-weight="700" fill="#0f172a">K</text>
        <text x="140" y="163" text-anchor="middle" font-size="10" fill="#475569">14(+)</text>
        <text x="140" y="204" text-anchor="middle" font-size="10" fill="#475569">13(-)</text>

        <!-- Relay Contact K (NO: 9 COM, 5 NO) -->
        <text x="218" y="96" font-size="13" font-weight="700" fill="#0f172a">K (NO)</text>
        <text x="282" y="74" font-size="10" fill="#475569">9(COM)</text>
        <circle cx="265" cy="76" r="3" fill="#fff" stroke="#dc2626" stroke-width="2"/>
        <circle cx="265" cy="110" r="3" fill="#fff" stroke="${relayOn ? '#ef4444' : '#334155'}" stroke-width="2"/>
        <line x1="265" y1="107" x2="${relayOn ? 265 : 251}" y2="${relayOn ? 76 : 80}" stroke="${relayOn ? hotStroke : idleStroke}" stroke-width="3" stroke-linecap="round"/>
        <path d="M265 110 V166" fill="none" stroke="${relayOn ? hotStroke : idleStroke}" stroke-width="2.8"/>
        <text x="282" y="118" font-size="10" fill="#475569">5(NO)</text>

        <!-- Lamp L1 -->
        <circle cx="265" cy="180" r="14" fill="${l1 ? '#fde047' : '#ffffff'}" stroke="#0f172a" stroke-width="2.2"/>
        <path d="M255 170 L275 190 M275 170 L255 190" stroke="#0f172a" stroke-width="2"/>
        <text x="296" y="185" font-size="13" font-weight="700" fill="#0f172a">L1</text>

        <!-- 0V Rail -->
        <path d="M140 192 V232 M265 194 V232 H45" fill="none" stroke="${gndStroke}" stroke-width="2.8"/>
        <circle cx="140" cy="232" r="4.5" fill="#0f172a"/>
        <circle cx="40" cy="232" r="5" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>
        <text x="25" y="220" font-size="13" font-weight="700" fill="#0f172a">0V</text>
      </svg>
    `;
  } else if (state.currentLabId === 'lab2_2') {
    // Relay Changeover Contact (SPDT) controlling L1 (NO) and L2 (NC) (Matches Doc2 image6)
    svgContent = `
      <svg viewBox="0 0 360 255">
        <text x="18" y="22" font-size="13" font-weight="700" fill="#dc2626">+12V</text>
        <circle cx="38" cy="36" r="5" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
        <path d="M43 36 H252 V74 M120 36 V74" fill="none" stroke="${hotStroke}" stroke-width="2.8"/>
        <circle cx="120" cy="36" r="4.5" fill="#0f172a"/>

        ${drawIECSwitchNO({
          id: 'S1',
          label: 'SW(S1)',
          x: 120,
          yTop: 74,
          pressed: s1,
          topEnergized: true,
          bottomEnergized: s1
        })}

        <path d="M120 108 V168" fill="none" stroke="${s1 ? hotStroke : idleStroke}" stroke-width="2.8"/>

        <!-- Coil K -->
        <rect x="98" y="168" width="44" height="24" fill="${relayOn ? '#dcfce7' : '#ffffff'}" stroke="#0f172a" stroke-width="2.2"/>
        <text x="80" y="185" font-size="13" font-weight="700" fill="#0f172a">K</text>
        <text x="120" y="163" text-anchor="middle" font-size="10" fill="#475569">14(+)</text>
        <text x="120" y="204" text-anchor="middle" font-size="10" fill="#475569">13(-)</text>

        <!-- Changeover Contact K (COM=9, NO=5->L1, NC=1->L2) -->
        <text x="206" y="92" font-size="13" font-weight="700" fill="#0f172a">K</text>
        <text x="262" y="70" font-size="10" fill="#475569">9(COM)</text>
        <circle cx="252" cy="74" r="3" fill="#fff" stroke="#dc2626" stroke-width="2"/>
        <!-- NC Post (Right) -->
        <path d="M262 104 H285 V166" fill="none" stroke="${!relayOn ? hotStroke : idleStroke}" stroke-width="2.8"/>
        <circle cx="268" cy="104" r="2.8" fill="#fff" stroke="${!relayOn ? '#ef4444' : '#334155'}" stroke-width="2"/>
        <text x="293" y="106" font-size="10" fill="#475569">1(NC)</text>
        <!-- NO Post (Left) -->
        <path d="M232 104 V166" fill="none" stroke="${relayOn ? hotStroke : idleStroke}" stroke-width="2.8"/>
        <circle cx="232" cy="104" r="2.8" fill="#fff" stroke="${relayOn ? '#ef4444' : '#334155'}" stroke-width="2"/>
        <text x="196" y="114" font-size="10" fill="#475569">5(NO)</text>
        <!-- Wiper Arm -->
        <line x1="252" y1="74" x2="${relayOn ? 232 : 268}" y2="104" stroke="${hotStroke}" stroke-width="3" stroke-linecap="round"/>

        <!-- Lamp L1 -->
        <circle cx="232" cy="180" r="14" fill="${l1 ? '#fde047' : '#ffffff'}" stroke="#0f172a" stroke-width="2.2"/>
        <path d="M222 170 L242 190 M242 170 L222 190" stroke="#0f172a" stroke-width="2"/>
        <text x="202" y="185" font-size="13" font-weight="700" fill="#0f172a">L1</text>

        <!-- Lamp L2 -->
        <circle cx="285" cy="180" r="14" fill="${l2 ? '#fde047' : '#ffffff'}" stroke="#0f172a" stroke-width="2.2"/>
        <path d="M275 170 L295 190 M295 170 L275 190" stroke="#0f172a" stroke-width="2"/>
        <text x="310" y="185" font-size="13" font-weight="700" fill="#0f172a">L2</text>

        <!-- 0V Rail -->
        <path d="M120 192 V232 M232 194 V232 M285 194 V232 H43" fill="none" stroke="${gndStroke}" stroke-width="2.8"/>
        <circle cx="120" cy="232" r="4.5" fill="#0f172a"/>
        <circle cx="232" cy="232" r="4.5" fill="#0f172a"/>
        <circle cx="38" cy="232" r="5" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>
        <text x="22" y="220" font-size="13" font-weight="700" fill="#0f172a">0V</text>
      </svg>
    `;
  } else if (state.currentLabId === 'lab2_latch') {
    // Self-holding circuit schematic with IEC NC Stop & NO Start
    const afterStopHot = !s2;
    const latchedHot = afterStopHot && (s1 || relayOn);
    svgContent = `
      <svg viewBox="0 0 360 255">
        <text x="15" y="22" font-size="13" font-weight="700" fill="#dc2626">+12V</text>
        <circle cx="35" cy="34" r="5" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
        <path d="M40 34 H130 V48" fill="none" stroke="${hotStroke}" stroke-width="2.6"/>

        ${drawIECSwitchNC({
          id: 'S2',
          label: 'S2(Stop)',
          x: 130,
          yTop: 48,
          pressed: s2,
          topEnergized: true,
          bottomEnergized: afterStopHot
        })}

        <path d="M130 82 V96 H215 V108 M130 96 V108" fill="none" stroke="${afterStopHot ? hotStroke : idleStroke}" stroke-width="2.6"/>
        <circle cx="130" cy="96" r="4" fill="#0f172a"/>

        ${drawIECSwitchNO({
          id: 'S1',
          label: 'S1(Start)',
          x: 130,
          yTop: 108,
          pressed: s1,
          topEnergized: afterStopHot,
          bottomEnergized: s1 && afterStopHot
        })}

        <!-- K1 NO Self-holding contact -->
        <text x="226" y="130" font-size="12" font-weight="700" fill="#0f172a">K1(9-5)</text>
        <circle cx="215" cy="108" r="2.8" fill="#fff" stroke="${afterStopHot ? '#ef4444' : '#334155'}" stroke-width="2"/>
        <circle cx="215" cy="142" r="2.8" fill="#fff" stroke="${latchedHot ? '#ef4444' : '#334155'}" stroke-width="2"/>
        <line x1="215" y1="139" x2="${relayOn ? 215 : 202}" y2="${relayOn ? 108 : 112}" stroke="${relayOn && afterStopHot ? hotStroke : idleStroke}" stroke-width="2.8" stroke-linecap="round"/>

        <path d="M130 142 V156 H290 V172 M215 142 V156 M130 156 V172" fill="none" stroke="${latchedHot ? hotStroke : idleStroke}" stroke-width="2.6"/>
        <circle cx="130" cy="156" r="4" fill="#0f172a"/>
        <circle cx="215" cy="156" r="4" fill="#0f172a"/>

        <!-- Coil K1 -->
        <rect x="110" y="172" width="40" height="22" fill="${relayOn ? '#dcfce7' : '#ffffff'}" stroke="#0f172a" stroke-width="2"/>
        <text x="86" y="188" font-size="12" font-weight="700" fill="#0f172a">K1</text>

        <!-- Lamp L1 -->
        <circle cx="290" cy="184" r="13" fill="${l1 ? '#fde047' : '#ffffff'}" stroke="#0f172a" stroke-width="2"/>
        <path d="M281 175 L299 193 M299 175 L281 193" stroke="#0f172a" stroke-width="2"/>
        <text x="312" y="188" font-size="12" font-weight="700" fill="#0f172a">L1</text>

        <path d="M130 194 V232 M290 197 V232 H40" fill="none" stroke="${gndStroke}" stroke-width="2.6"/>
        <circle cx="130" cy="232" r="4" fill="#0f172a"/>
        <circle cx="35" cy="232" r="5" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>
        <text x="18" y="220" font-size="13" font-weight="700" fill="#0f172a">0V</text>
      </svg>
    `;
  }

  container.innerHTML = svgContent;

  const fsClone = document.getElementById('fsSchematicClone');
  if (fsClone) {
    fsClone.innerHTML = svgContent;
  }

  // Allow clicking switch symbols directly inside the schematic to toggle S1/S2
  document.querySelectorAll('.schem-sw').forEach((el) => {
    el.addEventListener('click', () => {
      const sw = el.getAttribute('data-sw');
      if (sw && state.switches[sw]) {
        state.switches[sw].pressed = !state.switches[sw].pressed;
        updateSimulationUI();
      }
    });
  });
}

// Render Truth Table for Current Lab
function renderTruthTable(verificationResults = null) {
  if (verificationResults !== null) {
    state.lastVerificationResults = verificationResults;
  }

  const lab = LABS[state.currentLabId];
  const table = document.getElementById('truthTable');
  if (!lab || !table) return;

  const thead = table.querySelector('thead');
  let headers = '<tr><th>ลำดับ</th>';
  if (lab.isSequentialLatch) {
    headers += '<th>สภาวะการทดสอบ</th>';
  }
  lab.inputs.forEach((inp) => {
    headers += `<th>${inp}</th>`;
  });
  if (lab.requireRelay) {
    headers += '<th>Coil Relay</th>';
  }
  lab.outputs.forEach((out) => {
    headers += `<th>${out === 'L1' && lab.outputs.length === 1 ? 'LOAD (L1)' : out} (คาดหวัง)</th>`;
    headers += `<th>ผลลัพธ์จริง</th>`;
  });
  headers += '<th>สถานะ</th></tr>';
  thead.innerHTML = headers;

  highlightActiveTruthRow();
}

function highlightActiveTruthRow() {
  const lab = LABS[state.currentLabId];
  const table = document.getElementById('truthTable');
  if (!lab || !table) return;
  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  const s1 = state.switches.S1.pressed ? 1 : 0;
  const s2 = state.switches.S2.pressed ? 1 : 0;
  const relayOn = (state.simResult.K1 || state.simResult.K2) ? 1 : 0;

  // 1. Determine currently active row in lab.truthTable
  let activeRowIdx = -1;
  if (lab.isSequentialLatch) {
    if (s2 === 1) {
      activeRowIdx = 3;
    } else if (s1 === 1 && s2 === 0) {
      activeRowIdx = 1;
    } else if (s1 === 0 && s2 === 0 && relayOn) {
      activeRowIdx = 2;
    } else if (s1 === 0 && s2 === 0 && !relayOn) {
      activeRowIdx = 0;
    }
  } else {
    activeRowIdx = lab.truthTable.findIndex((row) => {
      const matchS1 = row.S1 === undefined || row.S1 === s1;
      const matchS2 = row.S2 === undefined || row.S2 === s2;
      return matchS1 && matchS2;
    });
  }

  // 2. If wires are connected, power is ON, and activeRowIdx is valid, compute live actual output
  if (!state.liveTestedRows) state.liveTestedRows = {};

  if (state.wires.length > 0 && state.powerOn && activeRowIdx !== -1) {
    const actualRelay = Boolean(state.simResult.K1 || state.simResult.K2);
    let rowPass = !state.simResult.shortCircuit;

    lab.outputs.forEach((out) => {
      const actualOut = state.simResult[out] ? 1 : 0;
      if (actualOut !== lab.truthTable[activeRowIdx].expected[out]) {
        rowPass = false;
      }
    });

    if (lab.requireRelay && (actualRelay ? 1 : 0) !== lab.truthTable[activeRowIdx].expected.RELAY) {
      rowPass = false;
    }

    state.liveTestedRows[activeRowIdx] = {
      passed: rowPass,
      actual: {
        L1: state.simResult.L1,
        L2: state.simResult.L2,
        RELAY: actualRelay
      }
    };
  }

  // 3. Render / update the rows in #truthTable tbody
  let rowsHtml = '';
  lab.truthTable.forEach((row, idx) => {
    const isActive = idx === activeRowIdx;
    const vRow = (state.liveTestedRows && state.liveTestedRows[idx])
      ? state.liveTestedRows[idx]
      : (state.lastVerificationResults && state.lastVerificationResults.rows && state.lastVerificationResults.rows[idx])
        ? state.lastVerificationResults.rows[idx]
        : null;

    rowsHtml += `<tr data-row-idx="${idx}" class="${isActive ? 'active-row' : ''}">`;

    // Column: ลำดับ
    rowsHtml += `<td>${isActive ? '<span class="live-row-indicator">▶</span> ' : ''}${idx + 1}</td>`;

    // Column: สภาวะการทดสอบ (Sequential Latch only)
    if (lab.isSequentialLatch) {
      rowsHtml += `<td style="text-align:left">${row.step}</td>`;
    }

    // Columns: Inputs (S1, S2)
    lab.inputs.forEach((inp) => {
      if (isActive) {
        const isPressed = row[inp] === 1;
        rowsHtml += `<td><span class="live-input-pill ${isPressed ? 'on' : 'off'}">${isPressed ? '1 (กด ON)' : '0 (ปล่อย)'}</span></td>`;
      } else {
        rowsHtml += `<td><b>${row[inp]}</b></td>`;
      }
    });

    // Column: Coil Relay (if required)
    if (lab.requireRelay) {
      const expRelay = row.expected.RELAY;
      if (vRow) {
        const relayActive = Boolean(vRow.actual.RELAY);
        rowsHtml += `<td><span class="live-out-pill ${relayActive ? 'on' : 'off'}">${relayActive ? '⚡ 1 (ทำงาน)' : '0 (หยุด)'}</span> <span style="font-size:0.75rem;color:#94a3b8">(${expRelay})</span></td>`;
      } else if (isActive && state.wires.length === 0) {
        rowsHtml += `<td><span class="live-out-pill idle">0 (ยังไม่ต่อสาย)</span> <span style="font-size:0.75rem;color:#94a3b8">(${expRelay})</span></td>`;
      } else {
        rowsHtml += `<td><b>${expRelay}</b></td>`;
      }
    }

    // Columns: Outputs (L1, L2)
    lab.outputs.forEach((out) => {
      const expVal = row.expected[out];
      rowsHtml += `<td><b>${expVal}</b></td>`;

      if (vRow) {
        const isLampOn = Boolean(vRow.actual[out]);
        rowsHtml += `<td><span class="live-out-pill ${isLampOn ? 'lamp-on' : 'lamp-off'}">${isLampOn ? '💡 1 (สว่าง)' : '⚫ 0 (ดับ)'}</span></td>`;
      } else if (isActive && state.wires.length === 0) {
        rowsHtml += `<td><span class="live-out-pill idle">⚫ 0 (ยังไม่ต่อสาย)</span></td>`;
      } else {
        rowsHtml += `<td>-</td>`;
      }
    });

    // Column: สถานะ
    if (vRow) {
      if (vRow.passed) {
        rowsHtml += `<td><span class="status-pill ok">${isActive ? '⚡ ทำงานถูกต้อง' : '✓ ถูกต้อง'}</span></td>`;
      } else {
        rowsHtml += `<td><span class="status-pill err">${isActive ? '⚠️ ไม่ตรงเงื่อนไข' : '✗ ผิดพลาด'}</span></td>`;
      }
    } else if (isActive && state.wires.length === 0) {
      rowsHtml += `<td><span class="status-pill" style="background:#334155;color:#cbd5e1">รอต่อสาย</span></td>`;
    } else {
      rowsHtml += `<td><span class="status-pill" style="background:#334155;color:#cbd5e1">รอตรวจ</span></td>`;
    }

    rowsHtml += `</tr>`;
  });

  tbody.innerHTML = rowsHtml;

  // Add click listener on each table row for interactive switch setting
  tbody.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => {
      const rowIdx = parseInt(tr.getAttribute('data-row-idx'), 10);
      if (isNaN(rowIdx)) return;
      const row = lab.truthTable[rowIdx];
      if (!row) return;

      if (lab.isSequentialLatch) {
        if (rowIdx === 0) {
          state.switches.S1.pressed = false;
          state.switches.S2.pressed = false;
          state.simResult.K1 = false;
          state.simResult.K2 = false;
        } else if (rowIdx === 1) {
          state.switches.S1.pressed = true;
          state.switches.S2.pressed = false;
        } else if (rowIdx === 2) {
          if (!state.simResult.K1 && !state.simResult.K2) {
            state.switches.S1.pressed = true;
            state.switches.S2.pressed = false;
            const res = evaluateCircuit(null, { K1: false, K2: false });
            state.simResult = res;
          }
          state.switches.S1.pressed = false;
          state.switches.S2.pressed = false;
        } else if (rowIdx === 3) {
          state.switches.S1.pressed = false;
          state.switches.S2.pressed = true;
        }
      } else {
        if (row.S1 !== undefined) state.switches.S1.pressed = Boolean(row.S1);
        if (row.S2 !== undefined) state.switches.S2.pressed = Boolean(row.S2);
      }
      updateSimulationUI();
    });
  });
}

// Automated Circuit Verification Engine
function runAutomatedVerification() {
  const lab = LABS[state.currentLabId];
  const banner = document.getElementById('verificationMessage');
  const scoreBadge = document.getElementById('scoreBadge');

  if (state.wires.length === 0) {
    banner.className = 'verification-banner error';
    banner.innerHTML = `
      <div class="banner-icon">⚠️</div>
      <div class="banner-text">
        <strong>ยังไม่ได้เชื่อมต่อสายไฟ:</strong> กรุณาลากสายไฟเชื่อมต่ออุปกรณ์บนชุดทดลองด้านขวาตามวงจรสัญลักษณ์ก่อนกดตรวจสอบ
      </div>
    `;
    scoreBadge.className = 'score-badge fail';
    scoreBadge.textContent = '0 / 10 คะแนน';
    return;
  }

  const rowResults = [];
  let allPassed = true;
  let hasShortCircuit = false;
  let relayState = { K1: false, K2: false };

  lab.truthTable.forEach((testCase) => {
    const sim = evaluateCircuit({ S1: testCase.S1, S2: testCase.S2 }, relayState);
    relayState = { K1: sim.K1, K2: sim.K2 };

    if (sim.shortCircuit) {
      hasShortCircuit = true;
    }

    const actualRelay = sim.K1 || sim.K2;
    let rowPass = !sim.shortCircuit;

    lab.outputs.forEach((out) => {
      const actualOut = sim[out] ? 1 : 0;
      if (actualOut !== testCase.expected[out]) {
        rowPass = false;
      }
    });

    if (lab.requireRelay && (actualRelay ? 1 : 0) !== testCase.expected.RELAY) {
      rowPass = false;
    }

    if (!rowPass) allPassed = false;

    rowResults.push({
      passed: rowPass,
      actual: {
        L1: sim.L1,
        L2: sim.L2,
        RELAY: actualRelay
      }
    });
  });

  renderTruthTable({ rows: rowResults });

  const passedCount = rowResults.filter((r) => r.passed).length;
  const totalCount = rowResults.length;
  const score = Math.round((passedCount / totalCount) * 10);

  if (hasShortCircuit) {
    banner.className = 'verification-banner error';
    banner.innerHTML = `
      <div class="banner-icon">🚨</div>
      <div class="banner-text">
        <strong>ตรวจพบการลัดวงจร (Short Circuit)!</strong> มีสายไฟต่อตรงระหว่างขั้ว <b>+12V</b> และ <b>0V (-)</b> โดยไม่ผ่านโหลดหรือคอยล์รีเลย์ กรุณาตรวจสอบจุดต่อสายใหม่
      </div>
    `;
    scoreBadge.className = 'score-badge fail';
    scoreBadge.textContent = 'ลัดวงจร (0/10)';
  } else if (allPassed) {
    banner.className = 'verification-banner success';
    banner.innerHTML = `
      <div class="banner-icon">✅</div>
      <div class="banner-text">
        <strong>ยอดเยี่ยม! วงจรทำงานถูกต้องสมบูรณ์ 100%</strong><br/>
        ผ่านการทดสอบครบทุกเงื่อนไขของตารางความจริง (${passedCount}/${totalCount} เงื่อนไข) — เปรียบเทียบการทำงาน: <b>${lab.logicComparison}</b>
      </div>
    `;
    scoreBadge.className = 'score-badge pass';
    scoreBadge.textContent = `ผ่าน (${score}/10 คะแนน)`;
  } else {
    let diagHint = 'ตรวจสอบการเลือกขั้ว NO / NC ของสวิตช์ และการต่อครบวงจรกลับไปยังขั้ว 0V (-)';
    if (lab.requireRelay) {
      diagHint = 'ตรวจสอบว่าต่อไฟเข้าคอยล์รีเลย์ (ขา 13-14) ผ่านสวิตช์ และนำไฟ +12V เข้าขา COM (ขา 9 หรือ 12) ออกขา NO (5 หรือ 8) / NC (1 หรือ 4) ไปยังหลอดไฟถูกต้องหรือไม่';
    }
    banner.className = 'verification-banner error';
    banner.innerHTML = `
      <div class="banner-icon">❌</div>
      <div class="banner-text">
        <strong>ผลการตรวจสอบยังไม่ถูกต้อง (${passedCount}/${totalCount} เงื่อนไข):</strong><br/>
        💡 <b>คำแนะนำแก้ไข:</b> ${diagHint}
      </div>
    `;
    scoreBadge.className = 'score-badge fail';
    scoreBadge.textContent = `${score} / 10 คะแนน`;
  }

  // Show toast inside Fullscreen Popup if active
  const fsToast = document.getElementById('fsVerifyToast');
  if (fsToast && document.body.classList.contains('fullscreen-popup-open')) {
    fsToast.className = `fs-verify-toast ${banner.className}`;
    fsToast.innerHTML = banner.innerHTML;
    fsToast.hidden = false;
    clearTimeout(fsToast._hideTimer);
    fsToast._hideTimer = setTimeout(() => {
      fsToast.hidden = true;
    }, 5500);
  }
}

// ============================================================================
// 5-Step Undo / Redo History Management
// ============================================================================
function cloneWires(wires) {
  return wires.map((w) => ({
    ...w,
    waypoints: (w.waypoints || []).map((pt) => ({ x: pt.x, y: pt.y })),
    bendPoint: w.bendPoint ? { x: w.bendPoint.x, y: w.bendPoint.y } : null
  }));
}

function recordHistorySnapshot() {
  state.undoStack.push(cloneWires(state.wires));
  if (state.undoStack.length > MAX_UNDO_STEPS) {
    state.undoStack.shift();
  }
  state.redoStack = [];
  updateUndoRedoUI();
}

function performUndo() {
  if (state.selectedTerminal && state.activeWaypoints.length > 0) {
    state.activeWaypoints.pop();
    updateSimulationUI();
    return;
  }
  if (state.selectedTerminal) {
    cancelActiveWireRouting();
    return;
  }
  if (state.undoStack.length === 0) return;

  state.redoStack.push(cloneWires(state.wires));
  if (state.redoStack.length > MAX_UNDO_STEPS) {
    state.redoStack.shift();
  }
  state.wires = state.undoStack.pop();
  state.liveTestedRows = {};
  state.lastVerificationResults = null;
  updateSimulationUI();
}

function performRedo() {
  if (state.redoStack.length === 0) return;
  state.undoStack.push(cloneWires(state.wires));
  if (state.undoStack.length > MAX_UNDO_STEPS) {
    state.undoStack.shift();
  }
  state.wires = state.redoStack.pop();
  state.liveTestedRows = {};
  state.lastVerificationResults = null;
  updateSimulationUI();
}

function updateUndoRedoUI() {
  const btnUndo = document.getElementById('btnUndo');
  const undoBtnText = document.getElementById('undoBtnText');
  const btnRedo = document.getElementById('btnRedo');
  const btnFsUndo = document.getElementById('btnFsUndo');
  const btnFsRedo = document.getElementById('btnFsRedo');

  const canUndoWaypoint = Boolean(state.selectedTerminal);
  const undoCount = state.undoStack.length;
  const labelText = canUndoWaypoint
    ? '↩ ลบจุดพักสาย'
    : `↩ ย้อนกลับ (${undoCount}/${MAX_UNDO_STEPS})`;

  if (btnUndo) {
    btnUndo.disabled = !canUndoWaypoint && undoCount === 0;
  }
  if (undoBtnText) {
    undoBtnText.textContent = canUndoWaypoint
      ? 'ลบจุดพักสาย'
      : `ย้อนกลับ (${undoCount}/${MAX_UNDO_STEPS})`;
  }
  if (btnRedo) {
    btnRedo.disabled = state.redoStack.length === 0;
  }
  if (btnFsUndo) {
    btnFsUndo.disabled = !canUndoWaypoint && undoCount === 0;
    btnFsUndo.textContent = labelText;
  }
  if (btnFsRedo) {
    btnFsRedo.disabled = state.redoStack.length === 0;
  }
}

// ============================================================================
// Fullscreen Popup Mode (Locks Mobile Viewport Scrolling Completely)
// ============================================================================
function setFullscreenPopupMode(enable) {
  const card = document.getElementById('workbenchCard');
  const quickBar = document.getElementById('fullscreenQuickBar');
  const fsBtnText = document.getElementById('fullscreenBtnText');
  const fsIcon = document.getElementById('fullscreenIcon');
  const fsSchem = document.getElementById('fsSchematicOverlay');
  const fsToast = document.getElementById('fsVerifyToast');

  document.body.classList.toggle('fullscreen-popup-open', enable);
  if (card) card.classList.toggle('is-fullscreen', enable);
  if (quickBar) quickBar.hidden = !enable;
  if (!enable && fsSchem) fsSchem.hidden = true;
  if (!enable && fsToast) fsToast.hidden = true;

  if (fsBtnText) {
    fsBtnText.textContent = enable ? 'ย่อกลับหน้าปกติ' : 'ขยายเต็มจอ (โหมดมือถือ)';
  }
  if (fsIcon) {
    fsIcon.textContent = enable ? '🗗' : '⛶';
  }

  updateSimulationUI();
}

// ============================================================================
// Zoom & Pan Engine for SVG Workbench (Pinch-to-Zoom, Wheel, Buttons, Pan Mode)
// ============================================================================
function applyViewBox() {
  const svg = document.getElementById('workbenchSvg');
  if (!svg) return;

  // Clamp viewBox within reasonable bounds so board never gets lost
  const maxX = BASE_VIEWBOX.w - state.viewBox.w;
  const maxY = BASE_VIEWBOX.h - state.viewBox.h;
  state.viewBox.x = Math.max(-60, Math.min(maxX + 60, state.viewBox.x));
  state.viewBox.y = Math.max(-60, Math.min(maxY + 60, state.viewBox.y));

  svg.setAttribute(
    'viewBox',
    `${state.viewBox.x.toFixed(1)} ${state.viewBox.y.toFixed(1)} ${state.viewBox.w.toFixed(1)} ${state.viewBox.h.toFixed(1)}`
  );

  const zoomText = document.getElementById('zoomLevelText');
  if (zoomText) {
    zoomText.textContent = `${Math.round(state.zoom * 100)}%`;
  }
}

function setZoomLevel(newZoom, focalSvgPt = null) {
  const clamped = Math.max(1, Math.min(3.0, newZoom));
  const cx = focalSvgPt ? focalSvgPt.x : state.viewBox.x + state.viewBox.w / 2;
  const cy = focalSvgPt ? focalSvgPt.y : state.viewBox.y + state.viewBox.h / 2;

  const newW = BASE_VIEWBOX.w / clamped;
  const newH = BASE_VIEWBOX.h / clamped;

  const ratioX = (cx - state.viewBox.x) / state.viewBox.w;
  const ratioY = (cy - state.viewBox.y) / state.viewBox.h;

  state.zoom = clamped;
  state.viewBox.w = newW;
  state.viewBox.h = newH;

  if (clamped === 1) {
    state.viewBox.x = 0;
    state.viewBox.y = 0;
  } else {
    state.viewBox.x = cx - ratioX * newW;
    state.viewBox.y = cy - ratioY * newH;
  }

  applyViewBox();
}

function resetZoom() {
  state.zoom = 1;
  state.viewBox = { x: 0, y: 0, w: BASE_VIEWBOX.w, h: BASE_VIEWBOX.h };
  applyViewBox();
}

// ============================================================================
// Delete Wire Mode Toggle (Prevents accidental wire deletion on click/tap)
// ============================================================================
function setDeleteWireMode(enable) {
  state.deleteWireMode = Boolean(enable);
  if (state.deleteWireMode && state.selectedTerminal) {
    cancelActiveWireRouting();
  }

  const svg = document.getElementById('workbenchSvg');
  if (svg) {
    svg.classList.toggle('delete-wire-mode', state.deleteWireMode);
  }

  const btns = [
    document.getElementById('btnDeleteMode'),
    document.getElementById('btnToolbarDeleteMode'),
    document.getElementById('btnFsDeleteMode')
  ];

  btns.forEach((btn) => {
    if (!btn) return;
    btn.classList.toggle('active', state.deleteWireMode);
    btn.setAttribute('aria-pressed', String(state.deleteWireMode));
    const lbl = btn.querySelector('.delete-mode-label');
    if (lbl) {
      lbl.textContent = state.deleteWireMode ? 'โหมดลบสาย: เปิด (แตะสาย)' : 'ลบสายไฟ';
    }
  });
}

// ============================================================================
// Smart Obstacle-Avoiding Auto-Router (Automatically routes wires around pins)
// ============================================================================
function simplifyWaypoints(p1, p2, rawWaypoints) {
  const all = [p1, ...(rawWaypoints || []), p2];
  const deduped = [all[0]];
  for (let i = 1; i < all.length; i++) {
    const prev = deduped[deduped.length - 1];
    if (Math.hypot(all[i].x - prev.x, all[i].y - prev.y) > 4) {
      deduped.push(all[i]);
    }
  }
  if (deduped.length <= 2) return [];

  const simplified = [];
  for (let i = 1; i < deduped.length - 1; i++) {
    const a = simplified.length > 0 ? simplified[simplified.length - 1] : deduped[0];
    const b = deduped[i];
    const c = deduped[i + 1];
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 > 1 && l2 > 1) {
      const cross = Math.abs(v1x * v2y - v1y * v2x) / (l1 * l2);
      const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
      // Skip collinear intermediate points
      if (cross < 0.06 && dot > 0) continue;
    }
    simplified.push({ x: b.x, y: b.y });
  }
  return simplified;
}

function autoRouteWire(fromTerm, toTerm) {
  const svg = document.getElementById('workbenchSvg');
  if (!svg || !fromTerm || !toTerm) return [];

  const p1 = getTerminalPosition(fromTerm);
  const p2 = getTerminalPosition(toTerm);

  // 1. Collect all other terminal positions as circular obstacles
  const obstacles = [];
  svg.querySelectorAll('.terminal-node').forEach((node) => {
    const tid = node.getAttribute('data-terminal');
    if (!tid || tid === fromTerm || tid === toTerm) return;
    const pos = getTerminalPosition(tid);
    obstacles.push({ x: pos.x, y: pos.y, r: 23 });
  });

  // 2. Collect existing wire segments to spread parallel wires into separate lanes
  const existingSegments = [];
  state.wires.forEach((w) => {
    const wp1 = getTerminalPosition(w.from);
    const wp2 = getTerminalPosition(w.to);
    const chain = [wp1, ...(w.waypoints || []), wp2];
    for (let i = 0; i < chain.length - 1; i++) {
      existingSegments.push({ a: chain[i], b: chain[i + 1] });
    }
  });

  // Switch plunger green actuator boxes to avoid covering PRESS buttons
  const switchBoxes = [
    { xMin: 214, xMax: 272, yMin: 235, yMax: 365 },
    { xMin: 214, xMax: 272, yMin: 430, yMax: 560 }
  ];

  const scoreCandidate = (rawWps, extraPenalty = 0) => {
    const wps = simplifyWaypoints(p1, p2, rawWps);
    const pts = [p1, ...wps, p2];
    let penalty = extraPenalty;
    let totalLen = 0;

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      totalLen += segLen;

      // Penalize passing over any other terminal
      for (let k = 0; k < obstacles.length; k++) {
        const obs = obstacles[k];
        const d = pointToSegmentDist(obs, a, b);
        if (d < obs.r) {
          penalty += 100000 + (obs.r - d) * 2000;
        } else if (d < obs.r + 8) {
          penalty += (obs.r + 8 - d) * 140;
        }
      }

      // Penalize crossing switch plungers
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      for (const box of switchBoxes) {
        if (mid.x >= box.xMin && mid.x <= box.xMax && mid.y >= box.yMin && mid.y <= box.yMax) {
          penalty += 30000;
        }
      }

      // Penalize overlapping existing wire segments in the same lane
      const isHoriz = Math.abs(b.y - a.y) < 3;
      const isVert = Math.abs(b.x - a.x) < 3;
      for (const es of existingSegments) {
        const esHoriz = Math.abs(es.b.y - es.a.y) < 3;
        const esVert = Math.abs(es.b.x - es.a.x) < 3;
        if (isHoriz && esHoriz && Math.abs(a.y - es.a.y) < 9) {
          const minA = Math.min(a.x, b.x);
          const maxA = Math.max(a.x, b.x);
          const minE = Math.min(es.a.x, es.b.x);
          const maxE = Math.max(es.a.x, es.b.x);
          if (Math.max(minA, minE) < Math.min(maxA, maxE)) {
            penalty += 1400;
          }
        } else if (isVert && esVert && Math.abs(a.x - es.a.x) < 9) {
          const minA = Math.min(a.y, b.y);
          const maxA = Math.max(a.y, b.y);
          const minE = Math.min(es.a.y, es.b.y);
          const maxE = Math.max(es.a.y, es.b.y);
          if (Math.max(minA, minE) < Math.min(maxA, maxE)) {
            penalty += 1400;
          }
        }
      }
    }

    const score = penalty + totalLen + wps.length * 42;
    return { wps, score };
  };

  const candidates = [];
  const directDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

  // Candidate 0: Direct (only favored when close & completely clear, otherwise prefer neat orthogonal routing)
  candidates.push(scoreCandidate([], directDist > 95 ? 220 : 0));

  // Candidate 1 & 2: 1-Corner L-shapes
  candidates.push(scoreCandidate([{ x: p1.x, y: p2.y }]));
  candidates.push(scoreCandidate([{ x: p2.x, y: p1.y }]));

  // Candidate 3: 2-Corner Horizontal Channel U/Z-shapes
  const yChannels = [
    18, 28, 40,
    168, 178, 188, 198, 208, 218,
    376, 386, 396, 408,
    556, 568, 580, 592,
    (p1.y + p2.y) / 2,
    Math.min(p1.y, p2.y) - 36,
    Math.min(p1.y, p2.y) - 52,
    Math.max(p1.y, p2.y) + 36,
    Math.max(p1.y, p2.y) + 52
  ];
  yChannels.forEach((yC) => {
    const yc = Math.max(16, Math.min(598, yC));
    candidates.push(scoreCandidate([{ x: p1.x, y: yc }, { x: p2.x, y: yc }]));
  });

  // Candidate 4: 2-Corner Vertical Channel U/Z-shapes
  const xChannels = [
    174, 186, 198, 210,
    288, 298, 308,
    372, 380,
    448, 460, 472, 486, 502, 516, 528,
    676, 686,
    840, 854, 868,
    (p1.x + p2.x) / 2,
    Math.min(p1.x, p2.x) - 36,
    Math.min(p1.x, p2.x) - 52,
    Math.max(p1.x, p2.x) + 36,
    Math.max(p1.x, p2.x) + 52
  ];
  xChannels.forEach((xC) => {
    const xc = Math.max(16, Math.min(898, xC));
    candidates.push(scoreCandidate([{ x: xc, y: p1.y }, { x: xc, y: p2.y }]));
  });

  // Candidate 5: 3-Corner Duct Combinations (for escaping inner component pins cleanly)
  const keyYDucts = [20, 36, 180, 194, 388, 566, 582];
  const keyXDucts = [186, 200, 300, 376, 456, 488, 516, 680, 850];
  keyYDucts.forEach((yD) => {
    keyXDucts.forEach((xD) => {
      candidates.push(
        scoreCandidate([
          { x: p1.x, y: yD },
          { x: xD, y: yD },
          { x: xD, y: p2.y }
        ])
      );
      candidates.push(
        scoreCandidate([
          { x: xD, y: p1.y },
          { x: xD, y: yD },
          { x: p2.x, y: yD }
        ])
      );
    });
  });

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0] ? candidates[0].wps : [];
}

// Add or Remove Wire (supports manual waypoints or automatic obstacle-avoiding routing & records 5-step undo history)
function addWire(fromTerm, toTerm, waypoints = []) {
  if (!fromTerm || !toTerm || fromTerm === toTerm) return;

  const exists = state.wires.some(
    (w) => (w.from === fromTerm && w.to === toTerm) || (w.from === toTerm && w.to === fromTerm)
  );
  if (exists) return;

  recordHistorySnapshot();

  // If user connected start -> end directly without manual waypoints, auto-route around terminals!
  const finalWaypoints =
    waypoints && waypoints.length > 0
      ? waypoints.map((pt) => ({ x: pt.x, y: pt.y }))
      : autoRouteWire(fromTerm, toTerm);

  state.wires.push({
    id: `wire_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    from: fromTerm,
    to: toTerm,
    color: state.wireColor,
    waypoints: finalWaypoints
  });

  state.liveTestedRows = {};
  state.lastVerificationResults = null;
  updateSimulationUI();
}

function removeWire(wireId) {
  const exists = state.wires.some((w) => w.id === wireId);
  if (!exists) return;

  recordHistorySnapshot();
  state.wires = state.wires.filter((w) => w.id !== wireId);
  state.liveTestedRows = {};
  state.lastVerificationResults = null;
  updateSimulationUI();
}

function cancelActiveWireRouting() {
  const preview = document.getElementById('dragWirePreview');
  state.selectedTerminal = null;
  state.activeWaypoints = [];
  state.draggingFrom = null;
  state.snapTerminal = null;
  updateSnapIndicator(null);
  if (preview) preview.setAttribute('opacity', '0');
  updateSimulationUI();
}

// Load Selected Lab Configuration
function loadLab(labId) {
  const lab = LABS[labId];
  if (!lab) return;

  state.currentLabId = labId;
  state.showingHints = false;
  state.selectedTerminal = null;
  state.activeWaypoints = [];
  state.liveTestedRows = {};
  state.lastVerificationResults = null;
  state.switches.S1.pressed = false;
  state.switches.S2.pressed = false;
  // For Latching Start-Stop lab, momentary mode is natural; for other labs, locked hold mode is default
  const defaultLock = !lab.isSequentialLatch;
  state.switches.S1.locked = defaultLock;
  state.switches.S2.locked = defaultLock;

  document.getElementById('labTitle').textContent = lab.title;
  document.getElementById('labObjective').textContent = lab.objective;

  const lamp2Group = document.getElementById('lamp2Group');
  const switch2Group = document.getElementById('switch2Group');
  const relaysGroup = document.getElementById('relaysGroup');

  lamp2Group.style.opacity = lab.showL2 ? '1' : '0.25';
  switch2Group.style.opacity = lab.showS2 ? '1' : '0.35';
  relaysGroup.style.opacity = lab.showRelays ? '1' : '0.35';

  const banner = document.getElementById('verificationMessage');
  banner.className = 'verification-banner neutral';
  banner.innerHTML = `
    <div class="banner-icon">ℹ️</div>
    <div class="banner-text">
      <strong>คำแนะนำ:</strong> บนมือถือแนะนำให้กดปุ่ม <b>"⛶ ขยายเต็มจอ (โหมดมือถือ)"</b> เพื่อล็อกหน้าจอไม่ให้เลื่อนขณะลากสายไฟ
    </div>
  `;
  const scoreBadge = document.getElementById('scoreBadge');
  scoreBadge.className = 'score-badge';
  scoreBadge.textContent = 'รอการตรวจสอบ';

  renderTruthTable();
  updateSimulationUI();
}

// Setup Pointer Events for Wire Dragging, Multi-Waypoint Routing, Pinch Zoom & Switch Controls
function initInteractions() {
  const svg = document.getElementById('workbenchSvg');
  const boardViewport = document.getElementById('boardViewport');
  const preview = document.getElementById('dragWirePreview');
  const tooltip = document.getElementById('terminalTooltip');

  // Crucial for iOS Safari / Android Chrome: block native page scroll when touching the board viewport
  ['touchstart', 'touchmove'].forEach((evtName) => {
    boardViewport.addEventListener(
      evtName,
      (e) => {
        // Allow tapping floating HTML buttons inside viewport, block scrolling on SVG canvas
        if (!e.target.closest('button')) {
          e.preventDefault();
        }
      },
      { passive: false }
    );
  });

  // Track active pointers for multi-touch pinch-to-zoom & two-finger pan on mobile
  const activePointers = new Map();
  let lastPinchDist = null;
  let lastPinchMidClient = null;
  let isSinglePanning = false;
  let panStartClient = null;
  let panStartViewBox = null;

  svg.addEventListener('pointerdown', (e) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // If 2 fingers are touching on mobile, switch to pinch-zoom / two-finger pan
    if (activePointers.size === 2) {
      state.draggingFrom = null;
      state.snapTerminal = null;
      updateSnapIndicator(null);
      isSinglePanning = false;
      const pts = Array.from(activePointers.values());
      lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      lastPinchMidClient = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      };
      return;
    }

    if (e.button === 2) {
      e.preventDefault();
      cancelActiveWireRouting();
      return;
    }

    // Check direct hit or magnetic proximity snap on pointerdown
    let termNode = e.target.closest('.terminal-node');
    const wireGroup = e.target.closest('.wire-group:not(.hint-wire)');
    const hitWireOrSwitch = wireGroup || e.target.closest('.switch-actuator');

    if (!termNode && !hitWireOrSwitch && !state.panMode && e.button === 0) {
      const touchPt = clientToSvgPoint(e.clientX, e.clientY);
      const nearSnap = findNearestSnapTerminal(touchPt, null, TAP_SNAP_RADIUS);
      if (nearSnap) {
        termNode = nearSnap.node;
      }
    }

    const isInteractiveTarget = termNode || hitWireOrSwitch;

    if (e.button === 1 || (state.panMode && !termNode && !e.target.closest('.switch-actuator'))) {
      e.preventDefault();
      isSinglePanning = true;
      svg.classList.add('panning');
      panStartClient = { x: e.clientX, y: e.clientY };
      panStartViewBox = { ...state.viewBox };
      return;
    }

    if (e.button !== 0) return;

    // If user touches/clicks a wire:
    // - In Delete Wire Mode (state.deleteWireMode === true): immediately delete that wire!
    // - In Normal Mode (state.deleteWireMode === false): press-and-drag bends/curves the wire (never deletes by accident!)
    if (wireGroup && !termNode && !state.selectedTerminal) {
      e.preventDefault();
      e.stopPropagation();
      const wireId = wireGroup.getAttribute('data-wire-id');

      if (state.deleteWireMode) {
        removeWire(wireId);
        return;
      }

      const wireObj = state.wires.find((w) => w.id === wireId);
      if (wireObj) {
        const touchPt = clientToSvgPoint(e.clientX, e.clientY);
        const wps = wireObj.waypoints || [];
        let mode = 'curve';
        let wpIndex = -1;

        if (wps.length > 0) {
          // Check if user grabbed an existing waypoint dot or near one
          const attrIdx = e.target.getAttribute('data-wp-index');
          if (attrIdx !== null) {
            mode = 'waypoint';
            wpIndex = Number(attrIdx);
          } else {
            let nearestIdx = -1;
            let nearestDist = 26;
            wps.forEach((wp, idx) => {
              const d = Math.hypot(wp.x - touchPt.x, wp.y - touchPt.y);
              if (d <= nearestDist) {
                nearestDist = d;
                nearestIdx = idx;
              }
            });
            if (nearestIdx !== -1) {
              mode = 'waypoint';
              wpIndex = nearestIdx;
            } else {
              // Find closest segment to insert a bend waypoint when dragged
              const p1 = getTerminalPosition(wireObj.from);
              const p2 = getTerminalPosition(wireObj.to);
              const chain = [p1, ...wps, p2];
              let bestSeg = 0;
              let bestSegDist = Infinity;
              for (let i = 0; i < chain.length - 1; i++) {
                const sd = pointToSegmentDist(touchPt, chain[i], chain[i + 1]);
                if (sd < bestSegDist) {
                  bestSegDist = sd;
                  bestSeg = i;
                }
              }
              mode = 'insert_waypoint';
              wpIndex = bestSeg;
            }
          }
        }

        state.bendingWire = {
          wireId,
          startClient: { x: e.clientX, y: e.clientY },
          hasMoved: false,
          historyRecorded: false,
          mode,
          wpIndex
        };
      }
      return;
    }

    if (termNode) {
      e.preventDefault();
      e.stopPropagation();
      if (state.deleteWireMode) {
        setDeleteWireMode(false);
      }
      const termId = termNode.getAttribute('data-terminal');

      // Complete wire if a start terminal was already selected
      if (state.selectedTerminal && state.selectedTerminal !== termId) {
        addWire(state.selectedTerminal, termId, state.activeWaypoints);
        state.selectedTerminal = null;
        state.activeWaypoints = [];
        state.draggingFrom = null;
        state.snapTerminal = null;
        updateSnapIndicator(null);
        preview.setAttribute('opacity', '0');
        updateSimulationUI();
        return;
      }

      // Clicking the same start terminal cancels routing
      if (state.selectedTerminal === termId && state.activeWaypoints.length > 0) {
        cancelActiveWireRouting();
        return;
      }

      // Start wire from this terminal
      state.selectedTerminal = termId;
      state.activeWaypoints = [];
      state.draggingFrom = termId;
      state.snapTerminal = null;
      state.pointerDownPos = { x: e.clientX, y: e.clientY };

      const startPt = getTerminalPosition(termId);
      preview.setAttribute('stroke', state.wireColor);
      preview.setAttribute('d', computeWirePath(startPt, startPt, []));
      preview.setAttribute('opacity', '0.9');
      updateSimulationUI();
      return;
    }

    // If user is currently routing a wire (state.selectedTerminal is set) and clicks on empty board space:
    // Add an intermediate waypoint to route around terminals/components!
    if (state.selectedTerminal && !isInteractiveTarget) {
      e.preventDefault();
      const wp = clientToSvgPoint(e.clientX, e.clientY);
      state.activeWaypoints.push({ x: wp.x, y: wp.y });
      const startPt = getTerminalPosition(state.selectedTerminal);
      preview.setAttribute('stroke', state.wireColor);
      preview.setAttribute('d', computeWirePath(startPt, wp, state.activeWaypoints));
      preview.setAttribute('opacity', '0.9');
      updateSimulationUI();
      return;
    }

    // If zoomed in (>1) and user drags empty board area (while not routing a wire), allow smooth panning!
    if (!state.selectedTerminal && state.zoom > 1 && !isInteractiveTarget) {
      isSinglePanning = true;
      svg.classList.add('panning');
      panStartClient = { x: e.clientX, y: e.clientY };
      panStartViewBox = { ...state.viewBox };
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Handle 2-finger pinch zoom & pan on mobile
    if (activePointers.size === 2) {
      state.bendingWire = null;
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const midClient = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      };

      if (lastPinchDist && lastPinchDist > 10) {
        const scaleFactor = dist / lastPinchDist;
        const focalPt = clientToSvgPoint(midClient.x, midClient.y);
        setZoomLevel(state.zoom * scaleFactor, focalPt);
      }

      if (lastPinchMidClient) {
        const rect = svg.getBoundingClientRect();
        const dxSvg = ((midClient.x - lastPinchMidClient.x) / rect.width) * state.viewBox.w;
        const dySvg = ((midClient.y - lastPinchMidClient.y) / rect.height) * state.viewBox.h;
        state.viewBox.x -= dxSvg;
        state.viewBox.y -= dySvg;
        applyViewBox();
      }

      lastPinchDist = dist;
      lastPinchMidClient = midClient;
      return;
    }

    // Handle live wire bending/curving when user holds & drags an existing wire
    if (state.bendingWire) {
      const wireObj = state.wires.find((w) => w.id === state.bendingWire.wireId);
      if (!wireObj) {
        state.bendingWire = null;
        return;
      }

      const moveDist = Math.hypot(
        e.clientX - state.bendingWire.startClient.x,
        e.clientY - state.bendingWire.startClient.y
      );

      if (moveDist >= 6 || state.bendingWire.hasMoved) {
        const rawPt = clientToSvgPoint(e.clientX, e.clientY);
        const clampedPt = {
          x: Math.max(14, Math.min(906, rawPt.x)),
          y: Math.max(14, Math.min(606, rawPt.y))
        };

        if (!state.bendingWire.historyRecorded) {
          recordHistorySnapshot();
          state.bendingWire.historyRecorded = true;
          state.bendingWire.hasMoved = true;

          if (state.bendingWire.mode === 'insert_waypoint') {
            wireObj.waypoints.splice(state.bendingWire.wpIndex, 0, {
              x: clampedPt.x,
              y: clampedPt.y
            });
            state.bendingWire.mode = 'waypoint';
          }
        }

        if (state.bendingWire.mode === 'curve') {
          wireObj.bendPoint = clampedPt;
        } else if (state.bendingWire.mode === 'waypoint') {
          wireObj.waypoints[state.bendingWire.wpIndex] = clampedPt;
        }

        tooltip.textContent = '〰️ กำลังดัดโค้งสายไฟ (ขั้วหัว-ท้ายคงเดิม)';
        tooltip.hidden = false;
        tooltip.style.left = `${Math.min(window.innerWidth - 230, Math.max(8, e.clientX - 60))}px`;
        tooltip.style.top = `${Math.max(8, e.clientY - 48)}px`;

        renderWires();
      }
      return;
    }

    // Handle single-finger / mouse panning when in Pan Mode or dragging empty zoomed canvas
    if (isSinglePanning && panStartClient && panStartViewBox) {
      const rect = svg.getBoundingClientRect();
      const dxSvg = ((e.clientX - panStartClient.x) / rect.width) * state.viewBox.w;
      const dySvg = ((e.clientY - panStartClient.y) / rect.height) * state.viewBox.h;
      state.viewBox.x = panStartViewBox.x - dxSvg;
      state.viewBox.y = panStartViewBox.y - dySvg;
      applyViewBox();
      return;
    }

    const activeStart = state.selectedTerminal || state.draggingFrom;
    const rawPt = clientToSvgPoint(e.clientX, e.clientY);

    if (!activeStart) {
      const termNode = e.target.closest('.terminal-node');
      if (termNode) {
        const label = termNode.getAttribute('data-label') || termNode.getAttribute('data-terminal');
        tooltip.textContent = label;
        tooltip.hidden = false;
        tooltip.style.left = `${e.clientX + 14}px`;
        tooltip.style.top = `${Math.max(8, e.clientY - 38)}px`;
      } else {
        tooltip.hidden = true;
      }
      return;
    }

    // Magnetic Snap-In: Check if finger/cursor is near any target terminal
    const snapTarget = findNearestSnapTerminal(rawPt, activeStart, MAGNETIC_SNAP_RADIUS);
    state.snapTerminal = snapTarget ? snapTarget.termId : null;
    updateSnapIndicator(snapTarget);

    if (snapTarget) {
      tooltip.textContent = `🧲 ดูดเข้าขั้ว: ${snapTarget.label} (ปล่อยเพื่อต่อสาย)`;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.min(window.innerWidth - 240, Math.max(8, e.clientX - 60))}px`;
      tooltip.style.top = `${Math.max(8, e.clientY - 48)}px`;
    } else {
      tooltip.hidden = true;
    }

    const startPt = getTerminalPosition(activeStart);
    const currPt = snapTarget ? snapTarget.pos : rawPt;
    const previewWaypoints =
      snapTarget && state.activeWaypoints.length === 0
        ? autoRouteWire(activeStart, snapTarget.termId)
        : state.activeWaypoints;
    preview.setAttribute('stroke', state.wireColor);
    preview.setAttribute('d', computeWirePath(startPt, currPt, previewWaypoints));
    preview.setAttribute('opacity', '0.95');
  });

  const handlePointerEnd = (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) {
      lastPinchDist = null;
      lastPinchMidClient = null;
    }
    if (isSinglePanning) {
      isSinglePanning = false;
      svg.classList.remove('panning');
      panStartClient = null;
      panStartViewBox = null;
    }
  };

  window.addEventListener('pointerup', (e) => {
    handlePointerEnd(e);
    tooltip.hidden = true;

    // Finish wire bending (never deletes wire on accidental tap when not in deleteWireMode!)
    if (state.bendingWire) {
      const bw = state.bendingWire;
      state.bendingWire = null;
      if (bw.hasMoved) {
        updateSimulationUI();
      }
      return;
    }

    if (!state.draggingFrom) return;

    const dragDist = state.pointerDownPos
      ? Math.hypot(e.clientX - state.pointerDownPos.x, e.clientY - state.pointerDownPos.y)
      : 999;

    // Only complete drag-and-drop if user actually dragged their finger/mouse (dragDist >= 10px)
    if (dragDist >= 10) {
      let toTerm = state.snapTerminal;

      if (!toTerm) {
        const upSvgPt = clientToSvgPoint(e.clientX, e.clientY);
        const snapUp = findNearestSnapTerminal(upSvgPt, state.draggingFrom, MAGNETIC_SNAP_RADIUS);
        if (snapUp) {
          toTerm = snapUp.termId;
        }
      }

      if (!toTerm) {
        const targetEl = document.elementFromPoint(e.clientX, e.clientY);
        const termNode = targetEl ? targetEl.closest('.terminal-node') : null;
        if (termNode) {
          toTerm = termNode.getAttribute('data-terminal');
        }
      }

      if (toTerm && toTerm !== state.draggingFrom) {
        addWire(state.draggingFrom, toTerm, state.activeWaypoints);
        state.selectedTerminal = null;
        state.activeWaypoints = [];
        preview.setAttribute('opacity', '0');
      }
    }

    state.snapTerminal = null;
    updateSnapIndicator(null);
    state.draggingFrom = null;
    updateSimulationUI();
  });

  window.addEventListener('pointercancel', handlePointerEnd);

  // Mouse Wheel Zoom on Workbench SVG
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const focalPt = clientToSvgPoint(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoomLevel(state.zoom * factor, focalPt);
    },
    { passive: false }
  );

  // Zoom Control Buttons
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnZoomReset = document.getElementById('btnZoomReset');
  const btnPanMode = document.getElementById('btnPanMode');

  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => setZoomLevel(state.zoom + 0.35));
  }
  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => setZoomLevel(state.zoom - 0.35));
  }
  if (btnZoomReset) {
    btnZoomReset.addEventListener('click', () => resetZoom());
  }
  if (btnPanMode) {
    btnPanMode.addEventListener('click', () => {
      state.panMode = !state.panMode;
      btnPanMode.classList.toggle('active', state.panMode);
      svg.classList.toggle('pan-mode', state.panMode);
    });
  }

  // Delete Wire Mode Toggle Buttons (Header, Workbench Toolbar, Fullscreen Quick Bar)
  ['btnDeleteMode', 'btnToolbarDeleteMode', 'btnFsDeleteMode'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', () => {
        setDeleteWireMode(!state.deleteWireMode);
      });
    }
  });

  // Fullscreen Popup Mode Controls
  const btnFullscreenToggle = document.getElementById('btnFullscreenToggle');
  const btnFsClose = document.getElementById('btnFsClose');
  const btnFsSchematic = document.getElementById('btnFsSchematic');
  const btnCloseFsSchem = document.getElementById('btnCloseFsSchem');
  const fsSchematicOverlay = document.getElementById('fsSchematicOverlay');
  const btnFsUndo = document.getElementById('btnFsUndo');
  const btnFsRedo = document.getElementById('btnFsRedo');
  const btnFsVerify = document.getElementById('btnFsVerify');

  if (btnFullscreenToggle) {
    btnFullscreenToggle.addEventListener('click', () => {
      const isNowFs = !document.body.classList.contains('fullscreen-popup-open');
      setFullscreenPopupMode(isNowFs);
    });
  }
  if (btnFsClose) {
    btnFsClose.addEventListener('click', () => setFullscreenPopupMode(false));
  }
  if (btnFsSchematic && fsSchematicOverlay) {
    btnFsSchematic.addEventListener('click', () => {
      fsSchematicOverlay.hidden = !fsSchematicOverlay.hidden;
    });
  }
  if (btnCloseFsSchem && fsSchematicOverlay) {
    btnCloseFsSchem.addEventListener('click', () => {
      fsSchematicOverlay.hidden = true;
    });
  }
  if (btnFsUndo) {
    btnFsUndo.addEventListener('click', () => performUndo());
  }
  if (btnFsRedo) {
    btnFsRedo.addEventListener('click', () => performRedo());
  }
  if (btnFsVerify) {
    btnFsVerify.addEventListener('click', () => runAutomatedVerification());
  }

  // Mobile / Floating Routing Helper Bar Buttons
  const btnUndoWaypoint = document.getElementById('btnUndoWaypoint');
  const btnCancelWire = document.getElementById('btnCancelWire');
  if (btnUndoWaypoint) {
    btnUndoWaypoint.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.activeWaypoints.length > 0) {
        state.activeWaypoints.pop();
        updateSimulationUI();
      }
    });
  }
  if (btnCancelWire) {
    btnCancelWire.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelActiveWireRouting();
    });
  }

  // Prevent context menu on workbench and use right-click to cancel active wire routing or undo last waypoint
  svg.addEventListener('contextmenu', (e) => {
    if (state.selectedTerminal) {
      e.preventDefault();
      if (state.activeWaypoints.length > 0) {
        state.activeWaypoints.pop();
        updateSimulationUI();
      } else {
        cancelActiveWireRouting();
      }
    }
  });

  // Keyboard shortcuts: Escape, Backspace, Ctrl+Z (Undo), Ctrl+Y (Redo)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.selectedTerminal) {
        cancelActiveWireRouting();
      } else if (state.deleteWireMode) {
        setDeleteWireMode(false);
      } else if (document.body.classList.contains('fullscreen-popup-open')) {
        setFullscreenPopupMode(false);
      }
    } else if (e.key === 'Backspace' && state.selectedTerminal && state.activeWaypoints.length > 0) {
      e.preventDefault();
      state.activeWaypoints.pop();
      updateSimulationUI();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      performUndo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      performRedo();
    }
  });

  // Pushbutton S1 & S2 interactions
  ['S1', 'S2'].forEach((sw, idx) => {
    const num = idx + 1;
    const plunger = document.getElementById(`s${num}PlungerGroup`);

    plunger.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (state.switches[sw].locked) {
        state.switches[sw].pressed = !state.switches[sw].pressed;
      } else {
        state.switches[sw].pressed = true;
      }
      updateSimulationUI();
    });

    window.addEventListener('pointerup', () => {
      if (!state.switches[sw].locked && state.switches[sw].pressed) {
        state.switches[sw].pressed = false;
        updateSimulationUI();
      }
    });
  });

  // Toolbar Switch Mode Toggle (Moved out of SVG board so it never blocks wire clicks!)
  const btnSwitchModeToggle = document.getElementById('btnSwitchModeToggle');
  if (btnSwitchModeToggle) {
    btnSwitchModeToggle.addEventListener('click', () => {
      const nextLock = !state.switches.S1.locked;
      state.switches.S1.locked = nextLock;
      state.switches.S2.locked = nextLock;
      if (!nextLock) {
        state.switches.S1.pressed = false;
        state.switches.S2.pressed = false;
      }
      updateSimulationUI();
    });
  }

  // Header Controls
  document.getElementById('labSelect').addEventListener('change', (e) => {
    state.wires = [];
    state.undoStack = [];
    state.redoStack = [];
    loadLab(e.target.value);
  });

  document.querySelectorAll('.color-swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chosenColor = btn.getAttribute('data-color');
      document.querySelectorAll('.color-swatch').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-color') === chosenColor);
      });
      state.wireColor = chosenColor;
    });
  });

  document.getElementById('btnUndo').addEventListener('click', () => {
    performUndo();
  });

  const btnRedo = document.getElementById('btnRedo');
  if (btnRedo) {
    btnRedo.addEventListener('click', () => {
      performRedo();
    });
  }

  document.getElementById('btnClear').addEventListener('click', () => {
    if (state.wires.length > 0) {
      recordHistorySnapshot();
    }
    state.wires = [];
    state.showingHints = false;
    state.liveTestedRows = {};
    state.lastVerificationResults = null;
    cancelActiveWireRouting();
    loadLab(state.currentLabId);
  });

  document.getElementById('btnHint').addEventListener('click', () => {
    const lab = LABS[state.currentLabId];
    if (!state.showingHints) {
      state.showingHints = true;
      updateSimulationUI();
    } else {
      recordHistorySnapshot();
      state.wires = lab.hintWires.map((hw, i) => ({
        id: `sol_${i}_${Date.now()}`,
        from: hw.from,
        to: hw.to,
        color: hw.color,
        waypoints: (hw.waypoints || []).map((pt) => ({ x: pt.x, y: pt.y }))
      }));
      state.showingHints = false;
      state.liveTestedRows = {};
      state.lastVerificationResults = null;
      updateSimulationUI();
      runAutomatedVerification();
    }
  });

  document.getElementById('btnVerify').addEventListener('click', () => {
    runAutomatedVerification();
  });

  const powerBtn = document.getElementById('btnPowerToggle');
  powerBtn.addEventListener('click', () => {
    state.powerOn = !state.powerOn;
    powerBtn.classList.toggle('on', state.powerOn);
    powerBtn.classList.toggle('off', !state.powerOn);
    powerBtn.setAttribute('aria-pressed', String(state.powerOn));
    powerBtn.querySelector('.power-state-text').textContent = state.powerOn
      ? 'ON (จ่ายไฟ)'
      : 'OFF (ตัดไฟ)';
    updateSimulationUI();
  });

  window.addEventListener('resize', () => {
    updateSimulationUI();
  });
}

// Initialize Application
window.addEventListener('DOMContentLoaded', () => {
  initWorkbenchComponents();
  initInteractions();
  loadLab('lab1_1');
});
