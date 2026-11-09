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
  plcModel: 'TM221CE16R', // 'TM221CE16R' (Schneider) or 'FX5U-32MR' (Mitsubishi)
  plcWiringLogic: 'negative', // 'negative' or 'positive'
  fuseBlown: { F1: false, F2: false, MAIN: false },
  isPlcBoardActive: false,
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

// Dynamic PLC Model Specification Helper (Schneider TM221CE16R vs Mitsubishi FX5U-32MR)
function getPlcModelSpec(model = (typeof state !== 'undefined' ? state.plcModel : 'TM221CE16R')) {
  const isFx = (model === 'FX5U-32MR');
  return {
    model: isFx ? 'FX5U-32MR' : 'TM221CE16R',
    brand: isFx ? 'Mitsubishi Electric' : 'Schneider Electric',
    fullName: isFx ? 'Mitsubishi MELSEC iQ-F FX5U-32MR/ES' : 'Schneider Modicon TM221CE16R',
    shortName: isFx ? 'FX5U-32MR' : 'TM221CE16R',
    inCom: isFx ? 'S/S' : 'COM',
    in0: isFx ? 'X0' : '%I0.0',
    in1: isFx ? 'X1' : '%I0.1',
    in2: isFx ? 'X2' : '%I0.2',
    in3: isFx ? 'X3' : '%I0.3',
    mem0: isFx ? 'M0' : '%M0',
    mem1: isFx ? 'M1' : '%M1',
    out0: isFx ? 'Y0' : '%Q0.0',
    out1: isFx ? 'Y1' : '%Q0.1',
    out2: isFx ? 'Y2' : '%Q0.2',
    out3: isFx ? 'Y3' : '%Q0.3',
    termIn: (idx) => (isFx ? (idx < 8 ? `X${idx}` : 'X10') : `%I0.${idx}`),
    termInShort: (idx) => (isFx ? (idx < 8 ? `X${idx}` : 'X10') : `I0.${idx}`),
    termOut: (idx) => (isFx ? `Y${idx}` : `%Q0.${idx}`),
    termOutShort: (idx) => (isFx ? `Y${idx}` : `Q${idx}`),
    ilHeader: isFx ? '(* Mitsubishi GX Works3 - Instruction List *)' : '(* EcoStruxure Machine Expert - Basic IL *)',
    ilLd: 'LD',
    ilLdn: isFx ? 'LDI' : 'LDN',
    ilAnd: 'AND',
    ilAndn: isFx ? 'ANI' : 'ANDN',
    ilOr: 'OR',
    ilOrn: isFx ? 'ORI' : 'ORN',
    ilOut: isFx ? 'OUT' : 'ST'
  };
}

// Helper to return the active hint / solution wires based on current wiring logic (Negative vs Positive)
function getActiveHintWires(lab) {
  if (!lab) return [];
  if (lab.isPlcTerminalLab && typeof state !== 'undefined' && state.plcWiringLogic === 'positive' && lab.hintWiresPositive) {
    return lab.hintWiresPositive;
  }
  return lab.hintWires || [];
}

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
  },
  lab4_1: {
    id: 'lab4_1',
    title: 'ใบงานที่ 4.1: การเชื่อมต่อสวิตช์อินพุต PLC (Negative Logic - S1 ➔ I0.0 / X0)',
    objective: 'เชื่อมต่อสวิตช์ปุ่มกด S1 (NO: ขั้ว 3-4) เข้ากับ Terminal กลางฝั่งอินพุตแบบ Negative Logic (Source Input): นำไฟ 24V ผ่านฟิวส์ F เข้าขั้ว COM (หรือ S/S) และนำ 0V ผ่านหน้าสัมผัส NO (3-4) ของ S1 เข้าขั้วอินพุต I0.0 (หรือ X0) เพื่อทดสอบร่วมกับโปรแกรม Ladder',
    isPlcTerminalLab: true,
    plcInputOnlyLab: true,
    inputs: ['S1'],
    outputs: ['L1', 'L2'],
    showL2: true,
    showS2: false,
    showRelays: false,
    truthTable: [
      { S1: 0, expected: { L1: 0, L2: 1 } },
      { S1: 1, expected: { L1: 1, L2: 0 } }
    ],
    logicComparison: 'การต่ออินพุต PLC แบบ Negative Logic (Source Input: 24V ➔ F ➔ COM/S/S และ 0V ➔ S1 ➔ I0.0/X0)',
    hintWires: [
      {
        from: 'PIN_24V_T',
        to: 'F1_B',
        color: '#ef4444',
        waypoints: [{ x: 48, y: 280 }, { x: 68, y: 260 }]
      },
      {
        from: 'F1_T',
        to: 'PIN_COM_T',
        color: '#ef4444',
        waypoints: [{ x: 92, y: 139 }, { x: 92, y: 350 }, { x: 118, y: 370 }]
      },
      {
        from: 'PIN_0V_T',
        to: 'S1_NO_2',
        color: '#3b82f6',
        waypoints: [{ x: 83, y: 330 }, { x: 225, y: 330 }]
      },
      {
        from: 'S1_NO_1',
        to: 'PIN_I0_T',
        color: '#ef4444',
        waypoints: [{ x: 161, y: 340 }, { x: 153, y: 360 }]
      }
    ],
    hintWiresPositive: [
      {
        from: 'PIN_0V_T',
        to: 'PIN_COM_T',
        color: '#3b82f6',
        waypoints: [{ x: 83, y: 365 }, { x: 118, y: 365 }]
      },
      {
        from: 'PIN_24V_T',
        to: 'F1_B',
        color: '#ef4444',
        waypoints: [{ x: 48, y: 280 }, { x: 68, y: 260 }]
      },
      {
        from: 'F1_T',
        to: 'S1_NO_2',
        color: '#ef4444',
        waypoints: [{ x: 92, y: 139 }, { x: 92, y: 330 }, { x: 225, y: 330 }]
      },
      {
        from: 'S1_NO_1',
        to: 'PIN_I0_T',
        color: '#ef4444',
        waypoints: [{ x: 161, y: 340 }, { x: 153, y: 360 }]
      }
    ]
  },
  lab4_2: {
    id: 'lab4_2',
    title: 'ใบงานที่ 4.2 (มอบหมายงาน): เชื่อมต่ออินพุต S1 และ S2 แบบ Negative Logic (AND Logic)',
    objective: 'มอบหมายงานท้ายใบงานที่ 4: เชื่อมต่อสวิตช์ S1 (NO 3-4) เข้าที่ขั้ว I0.0 (X0) และสวิตช์ S2 (NO 3-4) เข้าที่ขั้ว I0.1 (X1) แบบ Negative Logic (จ่ายไฟ 24V ผ่านฟิวส์ F เข้าขั้ว COM / S/S และพ่วง 0V เข้าสวิตช์ทั้งสอง) เพื่อให้เอาต์พุต Q0.0 (Y0) ทำงานเมื่อกด S1 และ S2 พร้อมกัน',
    isPlcTerminalLab: true,
    plcInputOnlyLab: true,
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
    logicComparison: 'การต่อสวิตช์อินพุต 2 ตัว (I0.0/X0 และ I0.1/X1) ร่วมกับคำสั่ง AND ในโปรแกรม PLC',
    hintWires: [
      {
        from: 'PIN_24V_T',
        to: 'F1_B',
        color: '#ef4444',
        waypoints: [{ x: 48, y: 280 }, { x: 68, y: 260 }]
      },
      {
        from: 'F1_T',
        to: 'PIN_COM_T',
        color: '#ef4444',
        waypoints: [{ x: 92, y: 139 }, { x: 92, y: 350 }, { x: 118, y: 370 }]
      },
      {
        from: 'PIN_0V_T',
        to: 'S1_NO_2',
        color: '#3b82f6',
        waypoints: [{ x: 83, y: 330 }, { x: 225, y: 330 }]
      },
      {
        from: 'S1_NO_2',
        to: 'S2_NO_2',
        color: '#3b82f6',
        waypoints: [{ x: 225, y: 265 }, { x: 385, y: 265 }]
      },
      {
        from: 'S1_NO_1',
        to: 'PIN_I0_T',
        color: '#ef4444',
        waypoints: [{ x: 161, y: 340 }, { x: 153, y: 360 }]
      },
      {
        from: 'S2_NO_1',
        to: 'PIN_I1_T',
        color: '#ef4444',
        waypoints: [{ x: 321, y: 340 }, { x: 188, y: 360 }]
      }
    ],
    hintWiresPositive: [
      {
        from: 'PIN_0V_T',
        to: 'PIN_COM_T',
        color: '#3b82f6',
        waypoints: [{ x: 83, y: 365 }, { x: 118, y: 365 }]
      },
      {
        from: 'PIN_24V_T',
        to: 'F1_B',
        color: '#ef4444',
        waypoints: [{ x: 48, y: 280 }, { x: 68, y: 260 }]
      },
      {
        from: 'F1_T',
        to: 'S1_NO_2',
        color: '#ef4444',
        waypoints: [{ x: 92, y: 139 }, { x: 92, y: 330 }, { x: 225, y: 330 }]
      },
      {
        from: 'S1_NO_2',
        to: 'S2_NO_2',
        color: '#ef4444',
        waypoints: [{ x: 225, y: 265 }, { x: 385, y: 265 }]
      },
      {
        from: 'S1_NO_1',
        to: 'PIN_I0_T',
        color: '#ef4444',
        waypoints: [{ x: 161, y: 340 }, { x: 153, y: 360 }]
      },
      {
        from: 'S2_NO_1',
        to: 'PIN_I1_T',
        color: '#ef4444',
        waypoints: [{ x: 321, y: 340 }, { x: 188, y: 360 }]
      }
    ]
  },
  lab5_1: {
    id: 'lab5_1',
    title: 'ใบงานที่ 5.1: การเชื่อมต่ออินพุตและเอาต์พุต PLC (PB1 ควบคุมหลอดไฟ PL1)',
    objective: 'เชื่อมต่อทั้งฝั่งอินพุตและเอาต์พุตเข้ากับ Terminal กลางตามแบบใบงานที่ 5: ฝั่งอินพุตต่อ 24V ผ่านฟิวส์ F เข้า COM (S/S) และต่อ 0V ผ่าน PB1 (NO 3-4) เข้า I0.0 (X0) | ฝั่งเอาต์พุตต่อ 24V ผ่านฟิวส์ F เข้า COM0, ต่อขั้วเอาต์พุต Q0 (Y0) เข้าหลอดไฟแดง PL1 (X1) และต่อ PL1 (X2) กลับลง 0V',
    isPlcTerminalLab: true,
    plcInputOnlyLab: false,
    inputs: ['S1'],
    outputs: ['L1'],
    showL2: false,
    showS2: false,
    showRelays: false,
    truthTable: [
      { S1: 0, expected: { L1: 0 } },
      { S1: 1, expected: { L1: 1 } }
    ],
    logicComparison: 'การเชื่อมต่อวงจรอินพุตและรีเลย์เอาต์พุตของ PLC (COM0 ➔ Q0/Y0 ➔ PL1)',
    hintWires: [
      {
        from: 'PIN_24V_T',
        to: 'F1_B',
        color: '#ef4444',
        waypoints: [{ x: 48, y: 280 }, { x: 68, y: 260 }]
      },
      {
        from: 'F1_T',
        to: 'PIN_COM_T',
        color: '#ef4444',
        waypoints: [{ x: 92, y: 139 }, { x: 92, y: 350 }, { x: 118, y: 370 }]
      },
      {
        from: 'PIN_0V_T',
        to: 'S1_NO_2',
        color: '#3b82f6',
        waypoints: [{ x: 83, y: 330 }, { x: 225, y: 330 }]
      },
      {
        from: 'S1_NO_1',
        to: 'PIN_I0_T',
        color: '#ef4444',
        waypoints: [{ x: 161, y: 340 }, { x: 153, y: 360 }]
      },
      {
        from: 'POUT_24V_T',
        to: 'F2_B',
        color: '#ef4444',
        waypoints: [{ x: 504, y: 330 }, { x: 518, y: 330 }]
      },
      {
        from: 'F2_T',
        to: 'POUT_COM0_T',
        color: '#ef4444',
        waypoints: [{ x: 548, y: 139 }, { x: 548, y: 350 }, { x: 577, y: 350 }]
      },
      {
        from: 'POUT_Q0_B',
        to: 'L1_A',
        color: '#ef4444',
        waypoints: [{ x: 614, y: 340 }, { x: 624, y: 340 }]
      },
      {
        from: 'L1_B',
        to: 'POUT_0V_B',
        color: '#3b82f6',
        waypoints: [{ x: 672, y: 360 }, { x: 541, y: 360 }]
      }
    ],
    hintWiresPositive: [
      {
        from: 'PIN_0V_T',
        to: 'PIN_COM_T',
        color: '#3b82f6',
        waypoints: [{ x: 83, y: 365 }, { x: 118, y: 365 }]
      },
      {
        from: 'PIN_24V_T',
        to: 'F1_B',
        color: '#ef4444',
        waypoints: [{ x: 48, y: 280 }, { x: 68, y: 260 }]
      },
      {
        from: 'F1_T',
        to: 'S1_NO_2',
        color: '#ef4444',
        waypoints: [{ x: 92, y: 139 }, { x: 92, y: 330 }, { x: 225, y: 330 }]
      },
      {
        from: 'S1_NO_1',
        to: 'PIN_I0_T',
        color: '#ef4444',
        waypoints: [{ x: 161, y: 340 }, { x: 153, y: 360 }]
      },
      {
        from: 'POUT_24V_T',
        to: 'F2_B',
        color: '#ef4444',
        waypoints: [{ x: 504, y: 330 }, { x: 518, y: 330 }]
      },
      {
        from: 'F2_T',
        to: 'POUT_COM0_T',
        color: '#ef4444',
        waypoints: [{ x: 548, y: 139 }, { x: 548, y: 350 }, { x: 577, y: 350 }]
      },
      {
        from: 'POUT_Q0_B',
        to: 'L1_A',
        color: '#ef4444',
        waypoints: [{ x: 614, y: 340 }, { x: 624, y: 340 }]
      },
      {
        from: 'L1_B',
        to: 'POUT_0V_B',
        color: '#3b82f6',
        waypoints: [{ x: 672, y: 360 }, { x: 541, y: 360 }]
      }
    ]
  },
  lab5_2: {
    id: 'lab5_2',
    title: 'ใบงานที่ 5.2 (มอบหมายงาน): เชื่อมต่อ PB1 ควบคุมหลอดไฟแดง (PL1) และเขียว (PL2) สลับกัน',
    objective: 'มอบหมายงานท้ายใบงานที่ 5: เชื่อมต่อสวิตช์ PB1 (I0.0 / X0) และต่อวงจรเอาต์พุตเข้ากับหลอดไฟสีแดง PL1 (Q0 / Y0) และหลอดไฟสีเขียว PL2 (Q1 / Y1) โดยเมื่อยังไม่กด PB1 (0) หลอดไฟสีแดง PL1 จะติดสว่าง และเมื่อกด PB1 (1) หลอดไฟสีเขียว PL2 จะติดสว่างแทน',
    isPlcTerminalLab: true,
    plcInputOnlyLab: false,
    inputs: ['S1'],
    outputs: ['L1', 'L2'],
    showL2: true,
    showS2: false,
    showRelays: false,
    truthTable: [
      { S1: 0, expected: { L1: 1, L2: 0 } },
      { S1: 1, expected: { L1: 0, L2: 1 } }
    ],
    logicComparison: 'การควบคุมเอาต์พุต 2 ช่อง (Q0/Y0 หลอดแดง และ Q1/Y1 หลอดเขียว) สลับสถานะด้วยหน้าสัมผัส NC/NO ในโปรแกรม PLC',
    hintWires: [
      {
        from: 'PIN_24V_T',
        to: 'F1_B',
        color: '#ef4444',
        waypoints: [{ x: 48, y: 280 }, { x: 68, y: 260 }]
      },
      {
        from: 'F1_T',
        to: 'PIN_COM_T',
        color: '#ef4444',
        waypoints: [{ x: 92, y: 139 }, { x: 92, y: 350 }, { x: 118, y: 370 }]
      },
      {
        from: 'PIN_0V_T',
        to: 'S1_NO_2',
        color: '#3b82f6',
        waypoints: [{ x: 83, y: 330 }, { x: 225, y: 330 }]
      },
      {
        from: 'S1_NO_1',
        to: 'PIN_I0_T',
        color: '#ef4444',
        waypoints: [{ x: 161, y: 340 }, { x: 153, y: 360 }]
      },
      {
        from: 'POUT_24V_T',
        to: 'F2_B',
        color: '#ef4444',
        waypoints: [{ x: 504, y: 330 }, { x: 518, y: 330 }]
      },
      {
        from: 'F2_T',
        to: 'POUT_COM0_T',
        color: '#ef4444',
        waypoints: [{ x: 548, y: 139 }, { x: 548, y: 350 }, { x: 577, y: 350 }]
      },
      {
        from: 'POUT_Q0_B',
        to: 'L1_A',
        color: '#ef4444',
        waypoints: [{ x: 614, y: 340 }, { x: 624, y: 340 }]
      },
      {
        from: 'POUT_Q1_B',
        to: 'L2_A',
        color: '#22c55e',
        waypoints: [{ x: 650, y: 340 }, { x: 779, y: 340 }]
      },
      {
        from: 'L1_B',
        to: 'L2_B',
        color: '#3b82f6',
        waypoints: [{ x: 672, y: 280 }, { x: 827, y: 280 }]
      },
      {
        from: 'L1_B',
        to: 'POUT_0V_B',
        color: '#3b82f6',
        waypoints: [{ x: 672, y: 360 }, { x: 541, y: 360 }]
      }
    ],
    hintWiresPositive: [
      {
        from: 'PIN_0V_T',
        to: 'PIN_COM_T',
        color: '#3b82f6',
        waypoints: [{ x: 83, y: 365 }, { x: 118, y: 365 }]
      },
      {
        from: 'PIN_24V_T',
        to: 'F1_B',
        color: '#ef4444',
        waypoints: [{ x: 48, y: 280 }, { x: 68, y: 260 }]
      },
      {
        from: 'F1_T',
        to: 'S1_NO_2',
        color: '#ef4444',
        waypoints: [{ x: 92, y: 139 }, { x: 92, y: 330 }, { x: 225, y: 330 }]
      },
      {
        from: 'S1_NO_1',
        to: 'PIN_I0_T',
        color: '#ef4444',
        waypoints: [{ x: 161, y: 340 }, { x: 153, y: 360 }]
      },
      {
        from: 'POUT_24V_T',
        to: 'F2_B',
        color: '#ef4444',
        waypoints: [{ x: 504, y: 330 }, { x: 518, y: 330 }]
      },
      {
        from: 'F2_T',
        to: 'POUT_COM0_T',
        color: '#ef4444',
        waypoints: [{ x: 548, y: 139 }, { x: 548, y: 350 }, { x: 577, y: 350 }]
      },
      {
        from: 'POUT_Q0_B',
        to: 'L1_A',
        color: '#ef4444',
        waypoints: [{ x: 614, y: 340 }, { x: 624, y: 340 }]
      },
      {
        from: 'POUT_Q1_B',
        to: 'L2_A',
        color: '#22c55e',
        waypoints: [{ x: 650, y: 340 }, { x: 779, y: 340 }]
      },
      {
        from: 'L1_B',
        to: 'L2_B',
        color: '#3b82f6',
        waypoints: [{ x: 672, y: 280 }, { x: 827, y: 280 }]
      },
      {
        from: 'L1_B',
        to: 'POUT_0V_B',
        color: '#3b82f6',
        waypoints: [{ x: 672, y: 360 }, { x: 541, y: 360 }]
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

  // 3. Build PLC Terminal Block Workbench for Lab 4 & Lab 5
  initPlcTerminalBoard();
}

// Build PLC Terminal Block Workbench (Lab 4 & Lab 5)
function initPlcTerminalBoard() {
  const container = document.getElementById('plcTerminalBoard');
  if (!container) return;

  const spec = getPlcModelSpec();

  let html = `
    <!-- LEFT PANEL: PLC INPUT SECTION (x=18, y=18, w=444, h=584) -->
    <g id="plcInputSectionGroup">
      <rect x="18" y="18" width="444" height="584" rx="8" fill="#ffffff" stroke="#94a3b8" stroke-width="2" filter="url(#shadow-card)" />
      <rect x="18" y="18" width="444" height="32" rx="8" fill="#1e293b" />
      <text x="240" y="39" text-anchor="middle" fill="#f8fafc" font-size="12.5" font-weight="700">ชุดเชื่อมต่อสวิตช์อินพุตเข้าสู่ TERMINAL กลาง (PLC INPUTS)</text>

      <!-- FUSE F1 (translate 42, 115) -->
      <g id="plcFuse1Group" transform="translate(42, 115)">
        <text x="26" y="-12" text-anchor="middle" fill="#0f172a" font-size="14" font-weight="700">FUSE</text>
        <rect id="plcFuse1Body" x="0" y="0" width="52" height="150" rx="6" fill="#38bdf8" stroke="#0284c7" stroke-width="2.5" />
        <rect id="plcFuse1Win" x="10" y="44" width="32" height="62" rx="3" fill="#f0f9ff" stroke="#0369a1" stroke-width="1.5" />
        <line id="plcFuse1Wire" x1="26" y1="48" x2="26" y2="102" stroke="#ef4444" stroke-width="2" stroke-dasharray="3 2" />
        <g id="plcFuse1BlownGroup" opacity="0" style="cursor: pointer;" title="ฟิวส์ F1 ขาด! คลิกเพื่อเปลี่ยน/รีเซตฟิวส์">
          <circle cx="26" cy="75" r="18" fill="#ef4444" opacity="0.35" filter="url(#glow-yellow)" />
          <line x1="26" y1="46" x2="21" y2="64" stroke="#fca5a5" stroke-width="2.2" stroke-linecap="round" />
          <line x1="26" y1="104" x2="31" y2="86" stroke="#fca5a5" stroke-width="2.2" stroke-linecap="round" />
          <text x="26" y="79" text-anchor="middle" font-size="14">💥</text>
          <rect x="-14" y="154" width="80" height="22" rx="11" fill="#dc2626" stroke="#fca5a5" stroke-width="1.5" />
          <text x="26" y="169" text-anchor="middle" fill="#ffffff" font-size="10" font-weight="800">🔄 รีเซตฟิวส์</text>
        </g>
        <text id="plcFuse1Label" x="26" y="78" text-anchor="middle" fill="#0369a1" font-size="18" font-weight="900" pointer-events="none">F</text>
        <text id="plcFuse1Amp" x="26" y="96" text-anchor="middle" fill="#0284c7" font-size="10" font-weight="700" pointer-events="none">0.1A</text>

        <!-- Top Screw F1_T (rel: 26, 24 -> global: 68, 139) -->
        <g class="terminal-node" data-terminal="F1_T" data-label="ฟิวส์ F (ฝั่งอินพุต - ขั้วบน)" transform="translate(26, 24)">
          <circle class="term-hit" r="22" fill="transparent" />
          <circle class="term-screw" r="14" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>

        <!-- Bottom Screw F1_B (rel: 26, 126 -> global: 68, 241) -->
        <g class="terminal-node" data-terminal="F1_B" data-label="ฟิวส์ F (ฝั่งอินพุต - ขั้วล่าง)" transform="translate(26, 126)">
          <circle class="term-hit" r="22" fill="transparent" />
          <circle class="term-screw" r="14" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
      </g>

      <!-- SWITCH S1 / PB1 (translate 135, 95) -->
      <g id="plcS1Group" transform="translate(135, 95)">
        <rect x="23" y="-22" width="70" height="24" rx="3" fill="#dbeafe" stroke="#334155" stroke-width="1.5" />
        <text x="58" y="-6" text-anchor="middle" fill="#0f172a" font-size="14" font-weight="800">PB1</text>
        
        <!-- Actuator button -->
        <g class="switch-actuator" data-plc-sw="S1" style="cursor: pointer;" title="คลิกเพื่อกดปุ่ม S1 (PB1)">
          <rect id="plcS1Cap" x="28" y="0" width="60" height="26" rx="5" fill="#10b981" stroke="#047857" stroke-width="2" />
          <text x="58" y="17" text-anchor="middle" fill="#ffffff" font-size="12" font-weight="700" pointer-events="none">PRESS</text>
        </g>
        <rect id="plcS1StatePill" x="18" y="30" width="80" height="18" rx="9" fill="#e2e8f0" />
        <text id="plcS1StateText" x="58" y="43" text-anchor="middle" fill="#334155" font-size="10" font-weight="700">ปกติ OFF (0)</text>

        <!-- Switch Body Box -->
        <rect x="0" y="52" width="116" height="113" rx="6" fill="#f8fafc" stroke="#64748b" stroke-width="2" />

        <!-- 1 NC 2 block -->
        <rect x="8" y="54" width="100" height="36" rx="4" fill="#fef08a" stroke="#ca8a04" stroke-width="1.5" />
        <text x="16" y="66" fill="#854d0e" font-size="11" font-weight="700">1</text>
        <text x="58" y="66" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="800">NC</text>
        <text x="100" y="66" text-anchor="end" fill="#854d0e" font-size="11" font-weight="700">2</text>
        <line id="plcS1NcBridge" x1="42" y1="72" x2="74" y2="72" stroke="#16a34a" stroke-width="3" stroke-linecap="round" />

        <!-- S1_NC_1 (rel: 26, 72 -> global: 161, 167) -->
        <g class="terminal-node" data-terminal="S1_NC_1" data-label="S1 ขั้ว 1 (NC)" transform="translate(26, 72)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
        <!-- S1_NC_2 (rel: 90, 72 -> global: 225, 167) -->
        <g class="terminal-node" data-terminal="S1_NC_2" data-label="S1 ขั้ว 2 (NC)" transform="translate(90, 72)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>

        <!-- 3 NO 4 block -->
        <rect x="8" y="116" width="100" height="36" rx="4" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.5" />
        <text x="16" y="128" fill="#14532d" font-size="11" font-weight="700">3</text>
        <text x="58" y="128" text-anchor="middle" fill="#14532d" font-size="12" font-weight="800">NO</text>
        <text x="100" y="128" text-anchor="end" fill="#14532d" font-size="11" font-weight="700">4</text>
        <line id="plcS1NoBridge" x1="42" y1="134" x2="74" y2="134" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 3" opacity="0.4" />

        <!-- S1_NO_1 (rel: 26, 134 -> global: 161, 229) -->
        <g class="terminal-node" data-terminal="S1_NO_1" data-label="S1 ขั้ว 3 (NO)" transform="translate(26, 134)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
        <!-- S1_NO_2 (rel: 90, 134 -> global: 225, 229) -->
        <g class="terminal-node" data-terminal="S1_NO_2" data-label="S1 ขั้ว 4 (NO)" transform="translate(90, 134)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
      </g>

      <!-- SWITCH S2 / PB2 (translate 295, 95) -->
      <g id="plcS2Group" transform="translate(295, 95)">
        <rect x="23" y="-22" width="70" height="24" rx="3" fill="#dbeafe" stroke="#334155" stroke-width="1.5" />
        <text x="58" y="-6" text-anchor="middle" fill="#0f172a" font-size="14" font-weight="800">PB2</text>
        
        <!-- Actuator button -->
        <g class="switch-actuator" data-plc-sw="S2" style="cursor: pointer;" title="คลิกเพื่อกดปุ่ม S2 (PB2)">
          <rect id="plcS2Cap" x="28" y="0" width="60" height="26" rx="5" fill="#10b981" stroke="#047857" stroke-width="2" />
          <text x="58" y="17" text-anchor="middle" fill="#ffffff" font-size="12" font-weight="700" pointer-events="none">PRESS</text>
        </g>
        <rect id="plcS2StatePill" x="18" y="30" width="80" height="18" rx="9" fill="#e2e8f0" />
        <text id="plcS2StateText" x="58" y="43" text-anchor="middle" fill="#334155" font-size="10" font-weight="700">ปกติ OFF (0)</text>

        <!-- Switch Body Box -->
        <rect x="0" y="52" width="116" height="113" rx="6" fill="#f8fafc" stroke="#64748b" stroke-width="2" />

        <!-- 1 NC 2 block -->
        <rect x="8" y="54" width="100" height="36" rx="4" fill="#fef08a" stroke="#ca8a04" stroke-width="1.5" />
        <text x="16" y="66" fill="#854d0e" font-size="11" font-weight="700">1</text>
        <text x="58" y="66" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="800">NC</text>
        <text x="100" y="66" text-anchor="end" fill="#854d0e" font-size="11" font-weight="700">2</text>
        <line id="plcS2NcBridge" x1="42" y1="72" x2="74" y2="72" stroke="#16a34a" stroke-width="3" stroke-linecap="round" />

        <!-- S2_NC_1 (rel: 26, 72 -> global: 321, 167) -->
        <g class="terminal-node" data-terminal="S2_NC_1" data-label="S2 ขั้ว 1 (NC)" transform="translate(26, 72)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
        <!-- S2_NC_2 (rel: 90, 72 -> global: 385, 167) -->
        <g class="terminal-node" data-terminal="S2_NC_2" data-label="S2 ขั้ว 2 (NC)" transform="translate(90, 72)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>

        <!-- 3 NO 4 block -->
        <rect x="8" y="116" width="100" height="36" rx="4" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.5" />
        <text x="16" y="128" fill="#14532d" font-size="11" font-weight="700">3</text>
        <text x="58" y="128" text-anchor="middle" fill="#14532d" font-size="12" font-weight="800">NO</text>
        <text x="100" y="128" text-anchor="end" fill="#14532d" font-size="11" font-weight="700">4</text>
        <line id="plcS2NoBridge" x1="42" y1="134" x2="74" y2="134" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 3" opacity="0.4" />

        <!-- S2_NO_1 (rel: 26, 134 -> global: 321, 229) -->
        <g class="terminal-node" data-terminal="S2_NO_1" data-label="S2 ขั้ว 3 (NO)" transform="translate(26, 134)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
        <!-- S2_NO_2 (rel: 90, 134 -> global: 385, 229) -->
        <g class="terminal-node" data-terminal="S2_NO_2" data-label="S2 ขั้ว 4 (NO)" transform="translate(90, 134)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
      </g>

      <!-- MIDDLE TERMINAL BLOCK - INPUT STRIP (12 COLUMNS) at (30, 395) -->
      <g id="plcInTerminalStrip" transform="translate(30, 395)">
        <text x="210" y="-14" text-anchor="middle" fill="#0f172a" font-size="13" font-weight="700">TERMINAL กลาง (เชื่อมต่อไปยังพอร์ต Input ของ PLC)</text>
        <rect x="0" y="0" width="420" height="152" rx="4" fill="#f8fafc" stroke="#334155" stroke-width="2.5" />
        <line x1="0" y1="48" x2="420" y2="48" stroke="#0f172a" stroke-width="3" />
  `;

  // Generate 12 input terminal columns
  for (let c = 0; c < 12; c++) {
    const xCol = c * 35;
    const xCenter = xCol + 17.5;
    let colId = '';
    let defLbl = '';
    let desc = '';
    let bgFill = '#f1f5f9';
    let textFill = '#0f172a';

    if (c === 0) {
      colId = 'PIN_24V';
      defLbl = '24V';
      desc = 'ไฟเลี้ยง +24VDC';
      bgFill = '#fee2e2';
      textFill = '#dc2626';
    } else if (c === 1) {
      colId = 'PIN_0V';
      defLbl = '0V';
      desc = 'กราวด์ 0VDC';
      bgFill = '#e0f2fe';
      textFill = '#0369a1';
    } else if (c === 2) {
      colId = 'PIN_COM';
      defLbl = spec.inCom;
      desc = `ขั้วร่วมคอมมอนอินพุต (${spec.inCom})`;
      bgFill = '#fef08a';
      textFill = '#854d0e';
    } else {
      const idx = c - 3;
      colId = `PIN_I${idx}`;
      defLbl = spec.termInShort(idx);
      desc = `พอร์ตอินพุต PLC (${defLbl})`;
      bgFill = '#f8fafc';
      textFill = '#1e293b';
    }

    if (c > 0) {
      html += `<line x1="${xCol}" y1="0" x2="${xCol}" y2="152" stroke="#cbd5e1" stroke-width="1.5" />`;
    }
    html += `<line x1="${xCenter}" y1="36" x2="${xCenter}" y2="60" stroke="#64748b" stroke-width="2.2" stroke-dasharray="3 2" />`;

    html += `
      <g class="terminal-node" data-terminal="${colId}_T" data-label="${desc} (บน)" transform="translate(${xCenter}, 24)">
        <circle class="term-hit" r="18" fill="transparent" />
        <circle class="term-screw" r="12" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
        <path d="M-6,0 H6 M0,-6 V6" stroke="#1e293b" stroke-width="2" />
      </g>
      <g class="terminal-node" data-terminal="${colId}_B" data-label="${desc} (ล่าง)" transform="translate(${xCenter}, 72)">
        <circle class="term-hit" r="18" fill="transparent" />
        <circle class="term-screw" r="12" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
        <path d="M-6,0 H6 M0,-6 V6" stroke="#1e293b" stroke-width="2" />
      </g>
      <rect x="${xCol}" y="96" width="35" height="36" fill="${bgFill}" stroke="#334155" stroke-width="1" />
      <text id="plcInLbl_${c}" class="plc-dyn-label" x="${xCenter}" y="119" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="10.5" font-weight="800" fill="${textFill}">${defLbl}</text>
      <rect x="${xCol}" y="132" width="35" height="20" fill="#f1f5f9" stroke="#334155" stroke-width="1" />
    `;

    if (c >= 3) {
      const k = c - 3;
      html += `<circle id="plcInLed_${k}" cx="${xCenter}" cy="142" r="5" fill="#334155" stroke="#1e293b" stroke-width="1.5" />`;
    }
  }
  html += `</g></g>`;

  // Center Watermark & Branding between PB2 and F2
  html += `
    <text x="466" y="195" text-anchor="middle" fill="#334155" opacity="0.65" font-size="13" font-weight="700" pointer-events="none">Kru-Jirawat.com</text>
    <text x="240" y="325" text-anchor="middle" fill="#64748b" opacity="0.13" font-size="34" font-weight="900" transform="rotate(-18, 240, 325)" pointer-events="none">Kru-Jirawat</text>
    <text x="686" y="325" text-anchor="middle" fill="#64748b" opacity="0.13" font-size="34" font-weight="900" transform="rotate(-18, 686, 325)" pointer-events="none">Kru-Jirawat</text>
  `;

  // RIGHT PANEL: PLC OUTPUT SECTION (x=470, y=18, w=432, h=584)
  html += `
    <g id="plcOutputSectionGroup">
      <rect x="470" y="18" width="432" height="584" rx="8" fill="#ffffff" stroke="#94a3b8" stroke-width="2" filter="url(#shadow-card)" />
      <rect x="470" y="18" width="432" height="32" rx="8" fill="#1e293b" />
      <text x="686" y="39" text-anchor="middle" fill="#f8fafc" font-size="12.5" font-weight="700">ชุดเชื่อมต่อโหลดเอาต์พุตจาก TERMINAL กลาง (PLC OUTPUTS)</text>

      <!-- PLC PANEL LED MONITOR GROUP (Dedicated for Lab 4 when Pilot Lamps are hidden) -->
      <g id="plcPanelLedMonitorGroup" transform="translate(500, 85)" style="display: none;">
        <rect x="0" y="0" width="374" height="200" rx="8" fill="#0f172a" stroke="#38bdf8" stroke-width="2" filter="url(#shadow-card)" />
        <rect x="0" y="0" width="374" height="30" rx="8" fill="#1e293b" />
        <text x="187" y="20" text-anchor="middle" fill="#38bdf8" font-size="12" font-weight="800">📊 PLC CPU STATUS INDICATOR PANEL (หน้าปัดหลอดไฟ PLC)</text>

        <!-- Status LEDs: PWR, RUN, ERR -->
        <g transform="translate(20, 42)">
          <circle cx="10" cy="10" r="5" fill="#22c55e" stroke="#15803d" stroke-width="1.5" />
          <text x="22" y="14" fill="#86efac" font-size="11" font-weight="700">PWR</text>
          
          <circle cx="75" cy="10" r="5" fill="#22c55e" stroke="#15803d" stroke-width="1.5" />
          <text x="87" y="14" fill="#86efac" font-size="11" font-weight="700">RUN</text>
          
          <circle cx="140" cy="10" r="5" fill="#334155" stroke="#1e293b" stroke-width="1.5" />
          <text x="152" y="14" fill="#64748b" font-size="11" font-weight="700">ERR</text>
          
          <text id="plcHwModelBadge" x="334" y="14" text-anchor="end" fill="#94a3b8" font-size="10.5" font-weight="700" font-family="'JetBrains Mono', monospace">${spec.shortName}</text>
        </g>

        <!-- Input Status LEDs Row -->
        <g transform="translate(16, 74)">
          <rect x="0" y="0" width="342" height="42" rx="4" fill="#1e293b" stroke="#334155" stroke-width="1" />
          <text x="8" y="25" fill="#f8fafc" font-size="11" font-weight="800">IN</text>
          ${Array.from({ length: 9 }).map((_, i) => {
            const x = 44 + i * 32.5;
            const inLbl = spec.termInShort(i);
            return `
              <g transform="translate(${x}, 5)">
                <text id="plcMonInLbl_${i}" x="12" y="10" text-anchor="middle" fill="#94a3b8" font-size="9" font-weight="700" font-family="'JetBrains Mono', monospace">${inLbl}</text>
                <circle id="plcMonInLed_${i}" cx="12" cy="22" r="5.5" fill="#1e293b" stroke="#475569" stroke-width="1.5" />
              </g>
            `;
          }).join('')}
        </g>

        <!-- Output Status LEDs Row -->
        <g transform="translate(16, 126)">
          <rect x="0" y="0" width="342" height="42" rx="4" fill="#1e293b" stroke="#334155" stroke-width="1" />
          <text x="8" y="25" fill="#f8fafc" font-size="11" font-weight="800">OUT</text>
          ${Array.from({ length: 7 }).map((_, i) => {
            const x = 44 + i * 42;
            const outLbl = spec.termOutShort(i);
            return `
              <g transform="translate(${x}, 5)">
                <text id="plcMonOutLbl_${i}" x="14" y="10" text-anchor="middle" fill="#94a3b8" font-size="9.5" font-weight="700" font-family="'JetBrains Mono', monospace">${outLbl}</text>
                <circle id="plcMonOutLed_${i}" cx="14" cy="22" r="5.5" fill="#1e293b" stroke="#475569" stroke-width="1.5" />
              </g>
            `;
          }).join('')}
        </g>

        <!-- Hint Footer inside Panel -->
        <text x="187" y="188" text-anchor="middle" fill="#38bdf8" font-size="10.5" font-weight="600">💡 ในใบงานที่ 4 ดูผลการทำงานของลอจิกจากไฟสถานะ Q0 (และ Q1) บนหน้าปัดนี้</text>
      </g>

      <!-- FUSE F2 (translate 492, 115) -->
      <g id="plcFuse2Group" transform="translate(492, 115)">
        <text x="26" y="-12" text-anchor="middle" fill="#0f172a" font-size="14" font-weight="700">FUSE</text>
        <rect id="plcFuse2Body" x="0" y="0" width="52" height="150" rx="6" fill="#38bdf8" stroke="#0284c7" stroke-width="2.5" />
        <rect id="plcFuse2Win" x="10" y="44" width="32" height="62" rx="3" fill="#f0f9ff" stroke="#0369a1" stroke-width="1.5" />
        <line id="plcFuse2Wire" x1="26" y1="48" x2="26" y2="102" stroke="#ef4444" stroke-width="2" stroke-dasharray="3 2" />
        <g id="plcFuse2BlownGroup" opacity="0" style="cursor: pointer;" title="ฟิวส์ F2 ขาด! คลิกเพื่อเปลี่ยน/รีเซตฟิวส์">
          <circle cx="26" cy="75" r="18" fill="#ef4444" opacity="0.35" filter="url(#glow-yellow)" />
          <line x1="26" y1="46" x2="21" y2="64" stroke="#fca5a5" stroke-width="2.2" stroke-linecap="round" />
          <line x1="26" y1="104" x2="31" y2="86" stroke="#fca5a5" stroke-width="2.2" stroke-linecap="round" />
          <text x="26" y="79" text-anchor="middle" font-size="14">💥</text>
          <rect x="-14" y="154" width="80" height="22" rx="11" fill="#dc2626" stroke="#fca5a5" stroke-width="1.5" />
          <text x="26" y="169" text-anchor="middle" fill="#ffffff" font-size="10" font-weight="800">🔄 รีเซตฟิวส์</text>
        </g>
        <text id="plcFuse2Label" x="26" y="78" text-anchor="middle" fill="#0369a1" font-size="18" font-weight="900" pointer-events="none">F</text>
        <text id="plcFuse2Amp" x="26" y="96" text-anchor="middle" fill="#0284c7" font-size="10" font-weight="700" pointer-events="none">0.1A</text>

        <!-- Top Screw F2_T (rel: 26, 24 -> global: 518, 139) -->
        <g class="terminal-node" data-terminal="F2_T" data-label="ฟิวส์ F (ฝั่งเอาต์พุต - ขั้วบน)" transform="translate(26, 24)">
          <circle class="term-hit" r="22" fill="transparent" />
          <circle class="term-screw" r="14" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>

        <!-- Bottom Screw F2_B (rel: 26, 126 -> global: 518, 241) -->
        <g class="terminal-node" data-terminal="F2_B" data-label="ฟิวส์ F (ฝั่งเอาต์พุต - ขั้วล่าง)" transform="translate(26, 126)">
          <circle class="term-hit" r="22" fill="transparent" />
          <circle class="term-screw" r="14" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
      </g>

      <!-- PILOT LAMP PL1 (RED) at (590, 95) -->
      <g id="plcLamp1Group" transform="translate(590, 95)">
        <!-- Top blue label box -->
        <rect x="23" y="-22" width="70" height="24" rx="3" fill="#dbeafe" stroke="#334155" stroke-width="1.5" />
        <text x="58" y="-6" text-anchor="middle" fill="#0f172a" font-size="14" font-weight="800">PL1</text>

        <!-- Lamp Dome Lens at top (y = 8..52) -->
        <circle id="plcLamp1Halo" cx="58" cy="36" r="40" fill="#ef4444" opacity="0" filter="url(#glow-yellow)" />
        <path id="plcLamp1Body" d="M 14 52 V 26 C 14 8, 102 8, 102 26 V 52 Z" fill="#7f1d1d" stroke="#1e293b" stroke-width="2.5" />
        <text id="plcLamp1Icon" x="58" y="38" text-anchor="middle" fill="#fca5a5" font-size="13" font-weight="800">RED</text>
        <rect x="14" y="52" width="88" height="24" fill="#cbd5e1" stroke="#1e293b" stroke-width="2" />

        <!-- Cylindrical lower body (y = 76..156) with X1 and X2 terminals at bottom -->
        <rect x="20" y="76" width="76" height="80" rx="8" fill="#e2e8f0" stroke="#475569" stroke-width="2" />
        <text x="34" y="114" text-anchor="middle" fill="#991b1b" font-family="'JetBrains Mono', monospace" font-size="12" font-weight="800">X1</text>
        <text x="82" y="114" text-anchor="middle" fill="#991b1b" font-family="'JetBrains Mono', monospace" font-size="12" font-weight="800">X2</text>
        
        <!-- L1_A (rel: 34, 134 -> global: 624, 229) -->
        <g class="terminal-node" data-terminal="L1_A" data-label="หลอดไฟแดง PL1 ขั้ว X1" transform="translate(34, 134)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
        <!-- L1_B (rel: 82, 134 -> global: 672, 229) -->
        <g class="terminal-node" data-terminal="L1_B" data-label="หลอดไฟแดง PL1 ขั้ว X2" transform="translate(82, 134)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
      </g>

      <!-- PILOT LAMP PL2 (GREEN) at (745, 95) -->
      <g id="plcLamp2Group" transform="translate(745, 95)">
        <!-- Top blue label box -->
        <rect x="23" y="-22" width="70" height="24" rx="3" fill="#dbeafe" stroke="#334155" stroke-width="1.5" />
        <text x="58" y="-6" text-anchor="middle" fill="#0f172a" font-size="14" font-weight="800">PL2</text>

        <!-- Lamp Dome Lens at top (y = 8..52) -->
        <circle id="plcLamp2Halo" cx="58" cy="36" r="40" fill="#22c55e" opacity="0" filter="url(#glow-green)" />
        <path id="plcLamp2Body" d="M 14 52 V 26 C 14 8, 102 8, 102 26 V 52 Z" fill="#064e3b" stroke="#1e293b" stroke-width="2.5" />
        <text id="plcLamp2Icon" x="58" y="38" text-anchor="middle" fill="#86efac" font-size="13" font-weight="800">GRN</text>
        <rect x="14" y="52" width="88" height="24" fill="#cbd5e1" stroke="#1e293b" stroke-width="2" />

        <!-- Cylindrical lower body (y = 76..156) with X1 and X2 terminals at bottom -->
        <rect x="20" y="76" width="76" height="80" rx="8" fill="#e2e8f0" stroke="#475569" stroke-width="2" />
        <text x="34" y="114" text-anchor="middle" fill="#14532d" font-family="'JetBrains Mono', monospace" font-size="12" font-weight="800">X1</text>
        <text x="82" y="114" text-anchor="middle" fill="#14532d" font-family="'JetBrains Mono', monospace" font-size="12" font-weight="800">X2</text>
        
        <!-- L2_A (rel: 34, 134 -> global: 779, 229) -->
        <g class="terminal-node" data-terminal="L2_A" data-label="หลอดไฟเขียว PL2 ขั้ว X1" transform="translate(34, 134)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
        <!-- L2_B (rel: 82, 134 -> global: 827, 229) -->
        <g class="terminal-node" data-terminal="L2_B" data-label="หลอดไฟเขียว PL2 ขั้ว X2" transform="translate(82, 134)">
          <circle class="term-hit" r="20" fill="transparent" />
          <circle class="term-screw" r="13" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
          <path d="M-7,0 H7 M0,-7 V7" stroke="#1e293b" stroke-width="2.2" />
        </g>
      </g>

      <!-- MIDDLE TERMINAL BLOCK - OUTPUT STRIP (11 COLUMNS) at (486, 395) -->
      <g id="plcOutTerminalStrip" transform="translate(486, 395)">
        <text x="200" y="-14" text-anchor="middle" fill="#0f172a" font-size="13" font-weight="700">TERMINAL กลาง (เชื่อมต่อมาจากพอร์ต Relay Output ของ PLC)</text>
        <rect x="0" y="0" width="401.5" height="152" rx="4" fill="#f8fafc" stroke="#334155" stroke-width="2.5" />
        <line x1="0" y1="48" x2="401.5" y2="48" stroke="#0f172a" stroke-width="3" />
  `;

  const outColDefs = [
    { id: 'POUT_24V', lbl: '24V', desc: 'ไฟเลี้ยง +24VDC', bg: '#fee2e2', fg: '#dc2626', led: null },
    { id: 'POUT_0V', lbl: '0V', desc: 'กราวด์ 0VDC', bg: '#e0f2fe', fg: '#0369a1', led: null },
    { id: 'POUT_COM0', lbl: 'COM0', desc: 'ขั้วคอมมอนเอาต์พุต COM0', bg: '#fef08a', fg: '#854d0e', led: null },
    { id: 'POUT_Q0', lbl: spec.termOutShort(0), desc: `เอาต์พุต (${spec.termOutShort(0)})`, bg: '#f8fafc', fg: '#1e293b', led: 0 },
    { id: 'POUT_Q1', lbl: spec.termOutShort(1), desc: `เอาต์พุต (${spec.termOutShort(1)})`, bg: '#f8fafc', fg: '#1e293b', led: 1 },
    { id: 'POUT_Q2', lbl: spec.termOutShort(2), desc: `เอาต์พุต (${spec.termOutShort(2)})`, bg: '#f8fafc', fg: '#1e293b', led: 2 },
    { id: 'POUT_Q3', lbl: spec.termOutShort(3), desc: `เอาต์พุต (${spec.termOutShort(3)})`, bg: '#f8fafc', fg: '#1e293b', led: 3 },
    { id: 'POUT_COM1', lbl: 'COM1', desc: 'ขั้วคอมมอนเอาต์พุต COM1', bg: '#fef08a', fg: '#854d0e', led: null },
    { id: 'POUT_Q4', lbl: spec.termOutShort(4), desc: `เอาต์พุต (${spec.termOutShort(4)})`, bg: '#f8fafc', fg: '#1e293b', led: 4 },
    { id: 'POUT_Q5', lbl: spec.termOutShort(5), desc: `เอาต์พุต (${spec.termOutShort(5)})`, bg: '#f8fafc', fg: '#1e293b', led: 5 },
    { id: 'POUT_Q6', lbl: spec.termOutShort(6), desc: `เอาต์พุต (${spec.termOutShort(6)})`, bg: '#f8fafc', fg: '#1e293b', led: 6 }
  ];

  outColDefs.forEach((col, c) => {
    const xCol = c * 36.5;
    const xCenter = xCol + 18.25;

    if (c > 0) {
      html += `<line x1="${xCol}" y1="0" x2="${xCol}" y2="152" stroke="#cbd5e1" stroke-width="1.5" />`;
    }
    html += `<line x1="${xCenter}" y1="36" x2="${xCenter}" y2="60" stroke="#64748b" stroke-width="2.2" stroke-dasharray="3 2" />`;

    html += `
      <g class="terminal-node" data-terminal="${col.id}_T" data-label="${col.desc} (บน)" transform="translate(${xCenter}, 24)">
        <circle class="term-hit" r="18" fill="transparent" />
        <circle class="term-screw" r="12" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
        <path d="M-6,0 H6 M0,-6 V6" stroke="#1e293b" stroke-width="2" />
      </g>
      <g class="terminal-node" data-terminal="${col.id}_B" data-label="${col.desc} (ล่าง)" transform="translate(${xCenter}, 72)">
        <circle class="term-hit" r="18" fill="transparent" />
        <circle class="term-screw" r="12" fill="url(#screwGrad)" stroke="#1e293b" stroke-width="2" />
        <path d="M-6,0 H6 M0,-6 V6" stroke="#1e293b" stroke-width="2" />
      </g>
      <rect x="${xCol}" y="96" width="36.5" height="36" fill="${col.bg}" stroke="#334155" stroke-width="1" />
      <text id="plcOutLbl_${c}" class="plc-dyn-label" x="${xCenter}" y="119" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="10.5" font-weight="800" fill="${col.fg}">${col.lbl}</text>
      <rect x="${xCol}" y="132" width="36.5" height="20" fill="#f1f5f9" stroke="#334155" stroke-width="1" />
    `;

    if (col.led !== null) {
      html += `<circle id="plcOutLed_${col.led}" cx="${xCenter}" cy="142" r="5" fill="#334155" stroke="#1e293b" stroke-width="1.5" />`;
    }
  });
  html += `</g></g>`;

  html += `
    <text x="26" y="594" fill="#64748b" font-size="12" font-weight="600" pointer-events="none">ชุดทดลองการเชื่อมต่ออินพุต-เอาต์พุต PLC ผ่าน TERMINAL กลาง</text>
    <text x="894" y="594" text-anchor="end" fill="#475569" font-size="12" font-weight="700" font-family="'JetBrains Mono', monospace" pointer-events="none">v2.6.0 | Kru-Jirawat</text>
  `;

  container.innerHTML = html;
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
  if (!svg) return { x: 0, y: 0 };
  const nodes = svg.querySelectorAll(`.terminal-node[data-terminal="${termId}"]`);
  if (!nodes || nodes.length === 0) return { x: 0, y: 0 };

  let node = nodes[0];
  if (nodes.length > 1) {
    for (const n of nodes) {
      if (!n.closest('[style*="display: none"]')) {
        node = n;
        break;
      }
    }
  }

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
    if (node.closest('[style*="display: none"]')) return;
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
  const lab = (typeof state !== 'undefined' && state.currentLabId) ? LABS[state.currentLabId] : null;
  const isPlcLab = Boolean(lab && lab.isPlcTerminalLab);

  // --- PLC Terminal Board Circuit Physics (Lab 4 & Lab 5) ---
  if (isPlcLab) {
    let f1Blown = (customInputs !== null) ? false : Boolean(state.fuseBlown && state.fuseBlown.F1);
    let f2Blown = (customInputs !== null) ? false : Boolean(state.fuseBlown && state.fuseBlown.F2);

    const inCols = ['PIN_24V', 'PIN_0V', 'PIN_COM', 'PIN_I0', 'PIN_I1', 'PIN_I2', 'PIN_I3', 'PIN_I4', 'PIN_I5', 'PIN_I6', 'PIN_I7', 'PIN_I8'];
    const outCols = ['POUT_24V', 'POUT_0V', 'POUT_COM0', 'POUT_Q0', 'POUT_Q1', 'POUT_Q2', 'POUT_Q3', 'POUT_COM1', 'POUT_Q4', 'POUT_Q5', 'POUT_Q6'];

    const buildGraph = (includeF1, includeF2, closedOutputs = {}) => {
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

      // 2. Fuses F1 and F2
      if (includeF1) addEdge('F1_T', 'F1_B');
      if (includeF2) addEdge('F2_T', 'F2_B');

      // 3. Internal vertical edges for Input Terminal strip (12 cols)
      inCols.forEach((c) => addEdge(`${c}_T`, `${c}_B`));

      // 4. Internal vertical edges for Output Terminal strip (11 cols)
      outCols.forEach((c) => addEdge(`${c}_T`, `${c}_B`));

      // 5. Switches S1 & S2 internal contacts
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

      // 6. Power rails
      addEdge('PWR_POS', 'PIN_24V_T');
      addEdge('PWR_POS', 'POUT_24V_T');
      addEdge('PWR_NEG', 'PIN_0V_T');
      addEdge('PWR_NEG', 'POUT_0V_T');

      // 7. Closed PLC output relay contacts
      if (closedOutputs.Q0) addEdge('POUT_COM0_T', 'POUT_Q0_T');
      if (closedOutputs.Q1) addEdge('POUT_COM0_T', 'POUT_Q1_T');
      if (closedOutputs.Q2) addEdge('POUT_COM0_T', 'POUT_Q2_T');
      if (closedOutputs.Q3) addEdge('POUT_COM0_T', 'POUT_Q3_T');
      if (closedOutputs.Q4) addEdge('POUT_COM1_T', 'POUT_Q4_T');
      if (closedOutputs.Q5) addEdge('POUT_COM1_T', 'POUT_Q5_T');
      if (closedOutputs.Q6) addEdge('POUT_COM1_T', 'POUT_Q6_T');

      return adj;
    };

    const runBfsOn = (adjMap) => {
      const pSet = new Set();
      const nSet = new Set();
      if (powerActive) {
        const qPos = ['PWR_POS'];
        pSet.add('PWR_POS');
        while (qPos.length > 0) {
          const curr = qPos.shift();
          for (const nxt of adjMap.get(curr) || []) {
            if (!pSet.has(nxt)) {
              pSet.add(nxt);
              qPos.push(nxt);
            }
          }
        }
        const qNeg = ['PWR_NEG'];
        nSet.add('PWR_NEG');
        while (qNeg.length > 0) {
          const curr = qNeg.shift();
          for (const nxt of adjMap.get(curr) || []) {
            if (!nSet.has(nxt)) {
              nSet.add(nxt);
              qNeg.push(nxt);
            }
          }
        }
      }
      return { pSet, nSet };
    };

    // Step 1: Check initial short circuits (before PLC outputs close)
    const { pSet: p0, nSet: n0 } = runBfsOn(buildGraph(!f1Blown, !f2Blown));
    if (powerActive && p0.has('PWR_NEG')) {
      const gNoF1 = runBfsOn(buildGraph(false, !f2Blown));
      if ((gNoF1.pSet.has('F1_T') && gNoF1.nSet.has('F1_B')) || (gNoF1.pSet.has('F1_B') && gNoF1.nSet.has('F1_T'))) {
        f1Blown = true;
      }
      const gNoF2 = runBfsOn(buildGraph(!f1Blown, false));
      if ((gNoF2.pSet.has('F2_T') && gNoF2.nSet.has('F2_B')) || (gNoF2.pSet.has('F2_B') && gNoF2.nSet.has('F2_T'))) {
        f2Blown = true;
      }
      if (!f1Blown && !f2Blown) {
        f1Blown = true;
      }
      if (!customInputs && powerActive) {
        if (f1Blown) state.fuseBlown.F1 = true;
        if (f2Blown) state.fuseBlown.F2 = true;
      }
    }

    // Step 2: Re-evaluate with updated (!f1Blown, !f2Blown) for PLC Inputs
    const { pSet: pos1, nSet: neg1 } = runBfsOn(buildGraph(!f1Blown, !f2Blown));
    const { pSet: posNoF1, nSet: negNoF1 } = runBfsOn(buildGraph(false, !f2Blown));

    const plcInputs = [];
    let detectedInputLogic = null;
    if (pos1.has('PIN_COM_T') && !neg1.has('PIN_COM_T')) {
      detectedInputLogic = 'negative';
    } else if (neg1.has('PIN_COM_T') && !pos1.has('PIN_COM_T')) {
      detectedInputLogic = 'positive';
    }

    let bypassedF1 = false;
    for (let k = 0; k <= 8; k++) {
      const pin = `PIN_I${k}_T`;
      const rawNeg = pos1.has('PIN_COM_T') && neg1.has(pin);
      const rawPos = neg1.has('PIN_COM_T') && pos1.has(pin);
      const noF1Neg = posNoF1.has('PIN_COM_T') && negNoF1.has(pin);
      const noF1Pos = negNoF1.has('PIN_COM_T') && posNoF1.has(pin);

      const validNeg = rawNeg && !noF1Neg;
      const validPos = rawPos && !noF1Pos;
      plcInputs[k] = powerActive && (validNeg || validPos);

      if (powerActive && ((rawNeg && noF1Neg) || (rawPos && noF1Pos))) {
        bypassedF1 = true;
      }
    }

    if (powerActive && posNoF1.has('PIN_COM_T') && !posNoF1.has('PWR_NEG')) {
      bypassedF1 = true;
    }

    const comPowered = powerActive && !f1Blown && (pos1.has('PIN_COM_T') || neg1.has('PIN_COM_T')) && !(posNoF1.has('PIN_COM_T') && pos1.has('PIN_COM_T') && !pos1.has('F1_T') && !pos1.has('F1_B'));

    // Step 3: Compute plcOutputs (Q0..Q6)
    const plcOutputs = { Q0: false, Q1: false, Q2: false, Q3: false, Q4: false, Q5: false, Q6: false };
    const currentLabId = (typeof state !== 'undefined' ? state.currentLabId : '');
    if (powerActive && comPowered && detectedInputLogic !== null) {
      if (currentLabId === 'lab4_1') {
        plcOutputs.Q0 = plcInputs[0];
        plcOutputs.Q1 = !plcInputs[0];
      } else if (currentLabId === 'lab4_2') {
        plcOutputs.Q0 = plcInputs[0] && plcInputs[1];
        plcOutputs.Q1 = false;
      } else if (currentLabId === 'lab5_1') {
        plcOutputs.Q0 = plcInputs[0];
        plcOutputs.Q1 = false;
      } else if (currentLabId === 'lab5_2') {
        plcOutputs.Q0 = !plcInputs[0];
        plcOutputs.Q1 = plcInputs[0];
      }
    }

    // Step 4: Close PLC Output Relay contacts and check for Output-side short circuits
    const { pSet: pos2, nSet: neg2 } = runBfsOn(buildGraph(!f1Blown, !f2Blown, plcOutputs));
    if (powerActive && pos2.has('PWR_NEG')) {
      const g2NoF2 = runBfsOn(buildGraph(!f1Blown, false, plcOutputs));
      if ((g2NoF2.pSet.has('F2_T') && g2NoF2.nSet.has('F2_B')) || (g2NoF2.pSet.has('F2_B') && g2NoF2.nSet.has('F2_T'))) {
        f2Blown = true;
      }
      const g2NoF1 = runBfsOn(buildGraph(false, !f2Blown, plcOutputs));
      if ((g2NoF1.pSet.has('F1_T') && g2NoF1.nSet.has('F1_B')) || (g2NoF1.pSet.has('F1_B') && g2NoF1.nSet.has('F1_T'))) {
        f1Blown = true;
      }
      if (!f1Blown && !f2Blown) {
        f2Blown = true;
      }
      if (!customInputs && powerActive) {
        if (f1Blown) state.fuseBlown.F1 = true;
        if (f2Blown) state.fuseBlown.F2 = true;
      }
    }

    // Step 5: Final BFS with any newly blown fuses opened
    const finalBfs = runBfsOn(buildGraph(!f1Blown, !f2Blown, plcOutputs));
    const noF2Bfs = runBfsOn(buildGraph(!f1Blown, false, plcOutputs));

    const isEnergizedWithF2 = (pinA, pinB) => {
      const onWithF2 = (finalBfs.pSet.has(pinA) && finalBfs.nSet.has(pinB)) || (finalBfs.pSet.has(pinB) && finalBfs.nSet.has(pinA));
      const onWithoutF2 = (noF2Bfs.pSet.has(pinA) && noF2Bfs.nSet.has(pinB)) || (noF2Bfs.pSet.has(pinB) && noF2Bfs.nSet.has(pinA));
      return !f2Blown && onWithF2 && !onWithoutF2;
    };

    const bypassedF2 = powerActive && (
      ((noF2Bfs.pSet.has('L1_A') && noF2Bfs.nSet.has('L1_B')) || (noF2Bfs.pSet.has('L1_B') && noF2Bfs.nSet.has('L1_A'))) ||
      ((noF2Bfs.pSet.has('L2_A') && noF2Bfs.nSet.has('L2_B')) || (noF2Bfs.pSet.has('L2_B') && noF2Bfs.nSet.has('L2_A')))
    );

    if (f1Blown) {
      plcInputs.fill(false);
      Object.keys(plcOutputs).forEach((k) => plcOutputs[k] = false);
    }

    const physicalL1 = isEnergizedWithF2('L1_A', 'L1_B');
    const physicalL2 = isEnergizedWithF2('L2_A', 'L2_B');

    let L1 = false;
    let L2 = false;
    if (lab.plcInputOnlyLab) {
      // For Lab 4.1 & 4.2 (Input-only wiring worksheets), PL1 and PL2 indicate PLC outputs
      L1 = physicalL1 || plcOutputs.Q0;
      L2 = physicalL2 || plcOutputs.Q1;
    } else {
      // For Lab 5.1 & 5.2 (Input & Output wiring worksheets), student must physically wire output loads!
      L1 = physicalL1;
      L2 = physicalL2;
    }

    return {
      shortCircuit: finalBfs.pSet.has('PWR_NEG') || f1Blown || f2Blown,
      fuseBlown: { F1: f1Blown, F2: f2Blown, MAIN: false },
      bypassedF1,
      bypassedF2,
      detectedInputLogic,
      L1,
      L2,
      K1: false,
      K2: false,
      plcInputs,
      plcOutputs,
      comPowered,
      posTerminals: finalBfs.pSet,
      negTerminals: finalBfs.nSet
    };
  }

  // --- Original Relay Board Evaluation for lab1_1..lab2_latch & Custom Labs ---
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
    if (short && !customInputs && powerActive) {
      if (state.fuseBlown) state.fuseBlown.MAIN = true;
    }
    const isMainBlown = !customInputs && Boolean(state.fuseBlown && state.fuseBlown.MAIN);
    if (short || isMainBlown) {
      return {
        shortCircuit: true,
        fuseBlown: { F1: false, F2: false, MAIN: true },
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
    fuseBlown: { F1: false, F2: false, MAIN: false },
    L1: isEnergized('L1_A', 'L1_B'),
    L2: isEnergized('L2_A', 'L2_B'),
    K1: k1Active,
    K2: k2Active,
    posTerminals: posSet,
    negTerminals: negSet
  };
}

function resetFuses() {
  state.fuseBlown = { F1: false, F2: false, MAIN: false };
  state.liveTestedRows = {};
  state.lastVerificationResults = null;
  updateSimulationUI();
}
window.resetFuses = resetFuses;

function updatePlcLogicModeUI() {
  const lab = (typeof state !== 'undefined' && state.currentLabId) ? LABS[state.currentLabId] : null;
  if (!lab || !lab.isPlcTerminalLab) return;

  const isPos = state.plcWiringLogic === 'positive';
  const labTitleEl = document.getElementById('labTitle');
  const labObjEl = document.getElementById('labObjective');

  if (state.currentLabId === 'lab4_1') {
    if (labTitleEl) {
      labTitleEl.textContent = isPos
        ? 'ใบงานที่ 4.1: การเชื่อมต่อสวิตช์อินพุต PLC (S1 ➔ I0.0 / X0 แบบ Positive Logic)'
        : 'ใบงานที่ 4.1: การเชื่อมต่อสวิตช์อินพุต PLC (S1 ➔ I0.0 / X0 แบบ Negative Logic)';
    }
    if (labObjEl) {
      labObjEl.textContent = isPos
        ? 'ฝึกปฏิบัติการต่อสายปุ่มกด S1 เข้าสู่ PLC Input Module แบบ Positive Logic (Sink Input: ขั้ว COM ต่อ 0V และสวิตช์จ่ายไฟ +24VDC ผ่านฟิวส์ F เข้า I0.0 / X0) และสังเกตสถานะหลอดไฟ LED ที่อินพุต'
        : 'ฝึกปฏิบัติการต่อสายปุ่มกด S1 เข้าสู่ PLC Input Module แบบ Negative Logic (Source Input: ขั้ว COM ต่อไฟ +24VDC ผ่านฟิวส์ F และสวิตช์ดึงลง 0V เข้า I0.0 / X0) และสังเกตสถานะหลอดไฟ LED ที่อินพุต';
    }
  } else if (state.currentLabId === 'lab4_2') {
    if (labTitleEl) {
      labTitleEl.textContent = isPos
        ? 'ใบงานที่ 4.2 (มอบหมายงาน): เชื่อมต่ออินพุต S1, S2 ควบคุมเอาต์พุต (AND Logic แบบ Positive Logic)'
        : 'ใบงานที่ 4.2 (มอบหมายงาน): เชื่อมต่ออินพุต S1, S2 ควบคุมเอาต์พุต (AND Logic แบบ Negative Logic)';
    }
    if (labObjEl) {
      labObjEl.textContent = isPos
        ? 'ฝึกปฏิบัติการต่อสวิตช์ S1 (I0.0/X0) และ S2 (I0.1/X1) แบบ Positive Logic (COM = 0V, สวิตช์จ่ายไฟ +24VDC ผ่านฟิวส์ F) เพื่อควบคุมให้เอาต์พุต Q0.0 / Y0 ทำงานเมื่อกดสวิตช์พร้อมกันทั้งสองตัว (AND Logic)'
        : 'ฝึกปฏิบัติการต่อสวิตช์ S1 (I0.0/X0) และ S2 (I0.1/X1) แบบ Negative Logic (COM = +24VDC ผ่านฟิวส์ F, สวิตช์ดึงลง 0V) เพื่อควบคุมให้เอาต์พุต Q0.0 / Y0 ทำงานเมื่อกดสวิตช์พร้อมกันทั้งสองตัว (AND Logic)';
    }
  } else if (state.currentLabId === 'lab5_1') {
    if (labTitleEl) {
      labTitleEl.textContent = isPos
        ? 'ใบงานที่ 5.1: การเชื่อมต่ออินพุตและเอาต์พุต PLC (PB1 ควบคุมหลอดไฟ PL1 แบบ Positive Logic)'
        : 'ใบงานที่ 5.1: การเชื่อมต่ออินพุตและเอาต์พุต PLC (PB1 ควบคุมหลอดไฟ PL1 แบบ Negative Logic)';
    }
    if (labObjEl) {
      labObjEl.textContent = isPos
        ? 'ฝึกปฏิบัติการต่อสายอินพุต PB1 แบบ Positive Logic (COM = 0V, PB1 จ่ายไฟ +24V เข้า I0.0) และเชื่อมต่อเอาต์พุต Q0.0 / Y0 ผ่านฟิวส์ F2 ไปขับโหลดหลอดไฟสัญญาณ PL1 (สีแดง) 24VDC'
        : 'ฝึกปฏิบัติการต่อสายอินพุต PB1 แบบ Negative Logic (COM = +24V, PB1 ดึงลง 0V เข้า I0.0) และเชื่อมต่อเอาต์พุต Q0.0 / Y0 ผ่านฟิวส์ F2 ไปขับโหลดหลอดไฟสัญญาณ PL1 (สีแดง) 24VDC';
    }
  } else if (state.currentLabId === 'lab5_2') {
    if (labTitleEl) {
      labTitleEl.textContent = isPos
        ? 'ใบงานที่ 5.2 (มอบหมายงาน): เชื่อมต่อ PB1 ควบคุมหลอดไฟ PL1 (แดง) และ PL2 (เขียว) สลับกัน (Positive Logic)'
        : 'ใบงานที่ 5.2 (มอบหมายงาน): เชื่อมต่อ PB1 ควบคุมหลอดไฟ PL1 (แดง) และ PL2 (เขียว) สลับกัน (Negative Logic)';
    }
    if (labObjEl) {
      labObjEl.textContent = isPos
        ? 'เชื่อมต่ออินพุต PB1 แบบ Positive Logic และเชื่อมต่อเอาต์พุต Q0.0 ควบคุมหลอดไฟ PL1 (แดง) และ Q0.1 ควบคุมหลอดไฟ PL2 (เขียว) ผ่านฟิวส์ F2 ให้ทำงานสลับกันตาม Ladder Diagram'
        : 'เชื่อมต่ออินพุต PB1 แบบ Negative Logic และเชื่อมต่อเอาต์พุต Q0.0 ควบคุมหลอดไฟ PL1 (แดง) และ Q0.1 ควบคุมหลอดไฟ PL2 (เขียว) ผ่านฟิวส์ F2 ให้ทำงานสลับกันตาม Ladder Diagram';
    }
  }
  renderSchematic();
}

// Update visual state of workbench, wires, lamps, relays, and schematic
function updateSimulationUI() {
  const prevRelays = { K1: state.simResult.K1, K2: state.simResult.K2 };
  const res = evaluateCircuit(null, prevRelays);
  state.simResult = res;

  // Short circuit indicator
  const shortAlert = document.getElementById('shortCircuitAlert');
  if (shortAlert) {
    shortAlert.setAttribute('opacity', res.shortCircuit ? '1' : '0');
  }

  // Update Fuses F1 & F2 visual state and Reset Fuse button
  const f1Blown = Boolean(state.fuseBlown && state.fuseBlown.F1);
  const f2Blown = Boolean(state.fuseBlown && state.fuseBlown.F2);
  const mainBlown = Boolean(state.fuseBlown && state.fuseBlown.MAIN);

  const f1Body = document.getElementById('plcFuse1Body');
  const f1Win = document.getElementById('plcFuse1Win');
  const f1Wire = document.getElementById('plcFuse1Wire');
  const f1BlownGroup = document.getElementById('plcFuse1BlownGroup');
  const f1Label = document.getElementById('plcFuse1Label');
  const f1Amp = document.getElementById('plcFuse1Amp');

  if (f1Body) {
    f1Body.setAttribute('fill', f1Blown ? '#450a0a' : '#38bdf8');
    f1Body.setAttribute('stroke', f1Blown ? '#ef4444' : '#0284c7');
  }
  if (f1Win) {
    f1Win.setAttribute('fill', f1Blown ? '#1e293b' : '#f0f9ff');
    f1Win.setAttribute('stroke', f1Blown ? '#ef4444' : '#0369a1');
  }
  if (f1Wire) f1Wire.setAttribute('opacity', f1Blown ? '0' : '1');
  if (f1BlownGroup) {
    f1BlownGroup.setAttribute('opacity', f1Blown ? '1' : '0');
    f1BlownGroup.style.pointerEvents = f1Blown ? 'auto' : 'none';
  }
  if (f1Label) f1Label.setAttribute('opacity', f1Blown ? '0' : '1');
  if (f1Amp) {
    f1Amp.textContent = f1Blown ? 'BLOWN' : '0.1A';
    f1Amp.setAttribute('fill', f1Blown ? '#fca5a5' : '#0284c7');
  }

  const f2Body = document.getElementById('plcFuse2Body');
  const f2Win = document.getElementById('plcFuse2Win');
  const f2Wire = document.getElementById('plcFuse2Wire');
  const f2BlownGroup = document.getElementById('plcFuse2BlownGroup');
  const f2Label = document.getElementById('plcFuse2Label');
  const f2Amp = document.getElementById('plcFuse2Amp');

  if (f2Body) {
    f2Body.setAttribute('fill', f2Blown ? '#450a0a' : '#38bdf8');
    f2Body.setAttribute('stroke', f2Blown ? '#ef4444' : '#0284c7');
  }
  if (f2Win) {
    f2Win.setAttribute('fill', f2Blown ? '#1e293b' : '#f0f9ff');
    f2Win.setAttribute('stroke', f2Blown ? '#ef4444' : '#0369a1');
  }
  if (f2Wire) f2Wire.setAttribute('opacity', f2Blown ? '0' : '1');
  if (f2BlownGroup) {
    f2BlownGroup.setAttribute('opacity', f2Blown ? '1' : '0');
    f2BlownGroup.style.pointerEvents = f2Blown ? 'auto' : 'none';
  }
  if (f2Label) f2Label.setAttribute('opacity', f2Blown ? '0' : '1');
  if (f2Amp) {
    f2Amp.textContent = f2Blown ? 'BLOWN' : '0.1A';
    f2Amp.setAttribute('fill', f2Blown ? '#fca5a5' : '#0284c7');
  }

  const btnResetFuse = document.getElementById('btnResetFuse');
  if (btnResetFuse) {
    btnResetFuse.style.display = (f1Blown || f2Blown || mainBlown) ? 'inline-flex' : 'none';
  }

  // Update Lamp L1 & L2 on Relay Board
  const lamp1Body = document.getElementById('lamp1Body');
  const lamp1Halo = document.getElementById('lamp1Halo');
  if (lamp1Body) lamp1Body.setAttribute('fill', res.L1 ? 'url(#lampOnGrad)' : 'url(#lampOffGrad)');
  if (lamp1Halo) lamp1Halo.setAttribute('opacity', res.L1 ? '0.95' : '0');

  const lamp2Body = document.getElementById('lamp2Body');
  const lamp2Halo = document.getElementById('lamp2Halo');
  if (lamp2Body) lamp2Body.setAttribute('fill', res.L2 ? 'url(#lampOnGrad)' : 'url(#lampOffGrad)');
  if (lamp2Halo) lamp2Halo.setAttribute('opacity', res.L2 ? '0.95' : '0');

  // Update Pilot Lamp PL1 & PL2 on PLC Terminal Board
  const plcLamp1Body = document.getElementById('plcLamp1Body');
  const plcLamp1Halo = document.getElementById('plcLamp1Halo');
  if (plcLamp1Body) plcLamp1Body.setAttribute('fill', res.L1 ? '#ef4444' : '#7f1d1d');
  if (plcLamp1Halo) plcLamp1Halo.setAttribute('opacity', res.L1 ? '0.95' : '0');

  const plcLamp2Body = document.getElementById('plcLamp2Body');
  const plcLamp2Halo = document.getElementById('plcLamp2Halo');
  if (plcLamp2Body) plcLamp2Body.setAttribute('fill', res.L2 ? '#22c55e' : '#064e3b');
  if (plcLamp2Halo) plcLamp2Halo.setAttribute('opacity', res.L2 ? '0.95' : '0');

  // Update PLC Input Terminal LEDs & Panel Monitor LEDs (0..8)
  for (let k = 0; k <= 8; k++) {
    const inActive = Boolean(res.plcInputs && res.plcInputs[k]);
    const inLed = document.getElementById(`plcInLed_${k}`);
    if (inLed) {
      inLed.setAttribute('fill', inActive ? '#22c55e' : '#334155');
    }
    const monInLed = document.getElementById(`plcMonInLed_${k}`);
    if (monInLed) {
      monInLed.setAttribute('fill', inActive ? '#22c55e' : '#1e293b');
      monInLed.setAttribute('stroke', inActive ? '#4ade80' : '#475569');
      monInLed.setAttribute('filter', inActive ? 'url(#glow-green)' : 'none');
    }
  }

  // Update PLC Output Terminal LEDs & Panel Monitor LEDs (0..6)
  for (let k = 0; k <= 6; k++) {
    const outActive = Boolean(res.plcOutputs && res.plcOutputs[`Q${k}`]);
    const outLed = document.getElementById(`plcOutLed_${k}`);
    if (outLed) {
      outLed.setAttribute('fill', outActive ? '#22c55e' : '#334155');
    }
    const monOutLed = document.getElementById(`plcMonOutLed_${k}`);
    if (monOutLed) {
      monOutLed.setAttribute('fill', outActive ? '#22c55e' : '#1e293b');
      monOutLed.setAttribute('stroke', outActive ? '#4ade80' : '#475569');
      monOutLed.setAttribute('filter', outActive ? 'url(#glow-green)' : 'none');
    }
  }

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

  // Update Switches S1 & S2 visual plunger & internal mechanical bridge (Relay Board)
  ['S1', 'S2'].forEach((sw, idx) => {
    const num = idx + 1;
    const pressed = state.switches[sw].pressed;
    const cap = document.getElementById(`s${num}Cap`);
    const ncBridge = document.getElementById(`s${num}NcBridge`);
    const noBridge = document.getElementById(`s${num}NoBridge`);
    const stateText = document.getElementById(`s${num}StateText`);
    const statePill = document.getElementById(`s${num}StatePill`);

    if (cap) {
      cap.setAttribute('x', pressed ? '10' : '0');
      cap.setAttribute('fill', pressed ? '#059669' : '#10b981');
    }

    if (ncBridge && noBridge) {
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
    }
  });

  // Update Switch S1 & S2 visuals on PLC Terminal Board
  ['S1', 'S2'].forEach((sw) => {
    const pressed = state.switches[sw].pressed;
    const cap = document.getElementById(`plc${sw}Cap`);
    const ncBridge = document.getElementById(`plc${sw}NcBridge`);
    const noBridge = document.getElementById(`plc${sw}NoBridge`);
    const stateText = document.getElementById(`plc${sw}StateText`);
    const statePill = document.getElementById(`plc${sw}StatePill`);

    if (cap) {
      cap.setAttribute('y', pressed ? '4' : '0');
      cap.setAttribute('fill', pressed ? '#059669' : '#10b981');
    }
    if (ncBridge) {
      ncBridge.setAttribute('stroke', pressed ? '#94a3b8' : '#16a34a');
      ncBridge.setAttribute('opacity', pressed ? '0.35' : '1');
    }
    if (noBridge) {
      noBridge.setAttribute('stroke', pressed ? '#16a34a' : '#94a3b8');
      noBridge.setAttribute('stroke-width', pressed ? '3.5' : '2');
      noBridge.setAttribute('stroke-dasharray', pressed ? 'none' : '3 3');
      noBridge.setAttribute('opacity', pressed ? '1' : '0.4');
    }
    if (stateText) {
      stateText.textContent = pressed ? 'กดค้าง ON (1)' : 'ปกติ OFF (0)';
      stateText.setAttribute('fill', pressed ? '#15803d' : '#334155');
    }
    if (statePill) {
      statePill.setAttribute('fill', pressed ? '#dcfce7' : '#e2e8f0');
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

  // Highlight energized terminals (only on visible board)
  document.querySelectorAll('.terminal-node').forEach((node) => {
    if (node.closest('[style*="display: none"]')) return;
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

  // Record real-time timing sample and refresh canvas
  recordTimingSample(true);
  renderTimingDiagramCanvas();

  // Render Schneider TM221CE16R PLC Ladder Diagram co-simulation
  renderPlcLadderDiagram();
}

function renderWires() {
  const layer = document.getElementById('wiresLayer');
  layer.innerHTML = '';

  const lab = LABS[state.currentLabId];
  const activeHints = getActiveHintWires(lab);
  if (state.showingHints && activeHints.length > 0) {
    activeHints.forEach((hw) => {
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

/**
 * วาดหน้าสัมผัสรีเลย์ NO (Normally Open Contact 9-5 - IEC 60617)
 */
function drawIECRelayContactNO({ x, yTop, label, closed, topEnergized, bottomEnergized }) {
  const yBot = yTop + 34;
  const bladeTopX = closed ? x : x - 13;
  const bladeTopY = closed ? yTop : yTop + 4;
  const strokeColor = (bottomEnergized || topEnergized) ? '#ef4444' : '#475569';
  return `
    <g class="schem-contact" style="cursor:default">
      <text x="${x - 48}" y="${yTop + 20}" font-size="11" font-weight="700" fill="#0f172a">${label}</text>
      <circle cx="${x}" cy="${yTop}" r="3" fill="#fff" stroke="${topEnergized ? '#ef4444' : '#334155'}" stroke-width="2"/>
      <circle cx="${x}" cy="${yBot}" r="3" fill="#fff" stroke="${bottomEnergized ? '#ef4444' : '#334155'}" stroke-width="2"/>
      <line x1="${x}" y1="${yBot - 2}" x2="${bladeTopX}" y2="${bladeTopY}" stroke="${strokeColor}" stroke-width="2.8" stroke-linecap="round"/>
    </g>
  `;
}

/**
 * วาดหน้าสัมผัสรีเลย์ NC (Normally Closed Break Contact 9-1 - IEC 60617)
 */
function drawIECRelayContactNC({ x, yTop, label, closed, topEnergized, bottomEnergized }) {
  const yBot = yTop + 34;
  const bladeTopX = closed ? x + 7 : x + 18;
  const bladeTopY = closed ? yTop : yTop + 4;
  const strokeColor = (bottomEnergized || topEnergized) ? '#ef4444' : '#475569';
  return `
    <g class="schem-contact" style="cursor:default">
      <text x="${x - 48}" y="${yTop + 20}" font-size="11" font-weight="700" fill="#0f172a">${label}</text>
      <circle cx="${x}" cy="${yTop}" r="3" fill="#fff" stroke="${topEnergized ? '#ef4444' : '#334155'}" stroke-width="2"/>
      <line x1="${x}" y1="${yTop}" x2="${x + 11}" y2="${yTop}" stroke="${topEnergized ? '#ef4444' : '#334155'}" stroke-width="2.2"/>
      <circle cx="${x}" cy="${yBot}" r="3" fill="#fff" stroke="${bottomEnergized ? '#ef4444' : '#334155'}" stroke-width="2"/>
      <line x1="${x}" y1="${yBot - 2}" x2="${bladeTopX}" y2="${bladeTopY}" stroke="${strokeColor}" stroke-width="2.8" stroke-linecap="round"/>
    </g>
  `;
}

function renderSchematicSlotComponent({
  comp,
  x,
  yTop,
  s1,
  s2,
  relayOn,
  topEnergized,
  botEnergized,
  interactive,
  builderMode,
  branch,
  slotType
}) {
  let innerHtml = '';
  const yBot = yTop + 34;

  if (comp === 'S1_NO') {
    innerHtml = drawIECSwitchNO({
      id: 'S1',
      label: 'S1(NO)',
      x,
      yTop,
      pressed: s1,
      topEnergized,
      bottomEnergized: botEnergized
    });
  } else if (comp === 'S1_NC') {
    innerHtml = drawIECSwitchNC({
      id: 'S1',
      label: 'S1(NC)',
      x,
      yTop,
      pressed: s1,
      topEnergized,
      bottomEnergized: botEnergized
    });
  } else if (comp === 'S2_NO') {
    innerHtml = drawIECSwitchNO({
      id: 'S2',
      label: 'S2(NO)',
      x,
      yTop,
      pressed: s2,
      topEnergized,
      bottomEnergized: botEnergized
    });
  } else if (comp === 'S2_NC') {
    innerHtml = drawIECSwitchNC({
      id: 'S2',
      label: 'S2(NC)',
      x,
      yTop,
      pressed: s2,
      topEnergized,
      bottomEnergized: botEnergized
    });
  } else if (comp === 'K1_NO') {
    innerHtml = drawIECRelayContactNO({
      x,
      yTop,
      label: 'K1(9-5)',
      closed: relayOn,
      topEnergized,
      bottomEnergized: botEnergized
    });
  } else if (comp === 'K1_NC') {
    innerHtml = drawIECRelayContactNC({
      x,
      yTop,
      label: 'K1(9-1)',
      closed: !relayOn,
      topEnergized,
      bottomEnergized: botEnergized
    });
  } else if (comp === 'WIRE_V') {
    const strokeColor = topEnergized ? '#ef4444' : '#475569';
    innerHtml = `<line x1="${x}" y1="${yTop}" x2="${x}" y2="${yBot}" stroke="${strokeColor}" stroke-width="2.8" stroke-linecap="round"/>`;
  } else {
    if (!builderMode) {
      innerHtml = `
        <circle cx="${x}" cy="${yTop}" r="2.8" fill="#fff" stroke="#475569" stroke-width="1.8"/>
        <circle cx="${x}" cy="${yBot}" r="2.8" fill="#fff" stroke="#475569" stroke-width="1.8"/>
      `;
    }
  }

  if (builderMode) {
    const hasComp = Boolean(comp);
    return `
      <g class="svg-slot-group" data-branch="${branch}" data-slot="${slotType}">
        <rect class="slot-box" x="${x - 30}" y="${yTop - 6}" width="60" height="46" rx="6"
              fill="${hasComp ? 'rgba(30, 41, 59, 0.5)' : 'rgba(15, 23, 42, 0.4)'}"
              stroke="${hasComp ? '#38bdf8' : '#475569'}"
              stroke-dasharray="${hasComp ? 'none' : '3 3'}" stroke-width="1.5"/>
        ${innerHtml}
        ${!hasComp ? `<text x="${x}" y="${yTop + 20}" font-size="10" font-weight="600" text-anchor="middle" fill="#64748b">+ วาง</text>` : ''}
      </g>
    `;
  }

  return innerHtml;
}

function renderSchematicLoadComponent({
  load,
  x,
  yCenter,
  energized,
  l1,
  l2,
  relayOn,
  builderMode,
  branch
}) {
  let innerHtml = '';
  const isL1Active = load === 'L1' && (builderMode ? energized : l1);
  const isL2Active = load === 'L2' && (builderMode ? energized : l2);
  const isCoilActive = load === 'K1_COIL' && (builderMode ? energized : relayOn);

  if (load === 'L1') {
    innerHtml = `
      <circle cx="${x}" cy="${yCenter}" r="13" fill="${isL1Active ? '#fde047' : '#ffffff'}" stroke="#0f172a" stroke-width="2.2"/>
      <path d="M ${x - 9} ${yCenter - 9} L ${x + 9} ${yCenter + 9} M ${x + 9} ${yCenter - 9} L ${x - 9} ${yCenter + 9}" stroke="#0f172a" stroke-width="1.8"/>
      <text x="${x + 18}" y="${yCenter + 4}" font-size="11" font-weight="700" fill="#0f172a">L1</text>
    `;
  } else if (load === 'L2') {
    innerHtml = `
      <circle cx="${x}" cy="${yCenter}" r="13" fill="${isL2Active ? '#fde047' : '#ffffff'}" stroke="#0f172a" stroke-width="2.2"/>
      <path d="M ${x - 9} ${yCenter - 9} L ${x + 9} ${yCenter + 9} M ${x + 9} ${yCenter - 9} L ${x - 9} ${yCenter + 9}" stroke="#0f172a" stroke-width="1.8"/>
      <text x="${x + 18}" y="${yCenter + 4}" font-size="11" font-weight="700" fill="#0f172a">L2</text>
    `;
  } else if (load === 'K1_COIL') {
    innerHtml = `
      <rect x="${x - 20}" y="${yCenter - 11}" width="40" height="22" rx="2" fill="${isCoilActive ? '#dcfce7' : '#ffffff'}" stroke="#0f172a" stroke-width="2"/>
      <text x="${x}" y="${yCenter + 4}" font-size="11" font-weight="700" text-anchor="middle" fill="#0f172a">K1</text>
      <text x="${x + 24}" y="${yCenter + 4}" font-size="9" font-weight="600" fill="#475569">14-13</text>
    `;
  }

  if (builderMode) {
    const hasLoad = Boolean(load);
    return `
      <g class="svg-slot-group" data-branch="${branch}" data-slot="loadSlot">
        <rect class="slot-box" x="${x - 30}" y="${yCenter - 15}" width="60" height="32" rx="6"
              fill="${hasLoad ? 'rgba(30, 41, 59, 0.5)' : 'rgba(15, 23, 42, 0.4)'}"
              stroke="${hasLoad ? '#38bdf8' : '#475569'}"
              stroke-dasharray="${hasLoad ? 'none' : '3 3'}" stroke-width="1.5"/>
        ${innerHtml}
        ${!hasLoad ? `<text x="${x}" y="${yCenter + 4}" font-size="10" font-weight="600" text-anchor="middle" fill="#64748b">+ โหลด</text>` : ''}
      </g>
    `;
  }

  return innerHtml;
}

function generateCustomSchematicSvg(schematic, options = {}) {
  const {
    s1 = false,
    s2 = false,
    l1 = false,
    l2 = false,
    relayOn = false,
    interactive = false,
    builderMode = false
  } = options;

  const hotStroke = '#ef4444';
  const idleStroke = '#475569';
  const gndStroke = '#64748b';

  const bXs = [85, 195, 305];
  const branches = schematic.branches || [
    { topSlot: null, midSlot: null, loadSlot: null },
    { topSlot: null, midSlot: null, loadSlot: null },
    { topSlot: null, midSlot: null, loadSlot: null }
  ];

  const isClosed = (comp) => {
    if (!comp) return false;
    if (comp === 'WIRE_V') return true;
    if (comp === 'S1_NO') return Boolean(s1);
    if (comp === 'S1_NC') return !s1;
    if (comp === 'S2_NO') return Boolean(s2);
    if (comp === 'S2_NC') return !s2;
    if (comp === 'K1_NO') return Boolean(relayOn);
    if (comp === 'K1_NC') return !relayOn;
    return false;
  };

  let topOut = [false, false, false];
  for (let b = 0; b < 3; b++) {
    topOut[b] = isClosed(branches[b] ? branches[b].topSlot : null);
  }
  if (schematic.bridge12) {
    const m = topOut[0] || topOut[1];
    topOut[0] = m;
    topOut[1] = m;
  }
  if (schematic.bridge23) {
    const m = topOut[1] || topOut[2];
    topOut[1] = m;
    topOut[2] = m;
  }
  if (schematic.bridge12) {
    const m = topOut[0] || topOut[1];
    topOut[0] = m;
    topOut[1] = m;
  }

  let midOut = [false, false, false];
  for (let b = 0; b < 3; b++) {
    midOut[b] = topOut[b] && isClosed(branches[b] ? branches[b].midSlot : null);
  }

  let svg = `
    <svg viewBox="0 0 380 260" class="custom-schem-svg">
      <!-- Top Rail: +12V -->
      <text x="18" y="22" font-size="13" font-weight="700" fill="#dc2626">+12V</text>
      <circle cx="36" cy="34" r="5" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
      <path d="M 41 34 H 305" fill="none" stroke="${hotStroke}" stroke-width="2.8"/>
  `;

  for (let b = 0; b < 3; b++) {
    const bx = bXs[b];
    const bObj = branches[b] || {};
    const topComp = bObj.topSlot;
    const midComp = bObj.midSlot;
    const loadComp = bObj.loadSlot;

    svg += `<circle cx="${bx}" cy="34" r="4" fill="#0f172a"/>`;
    svg += `<path d="M ${bx} 34 V 50" fill="none" stroke="${hotStroke}" stroke-width="2.6"/>`;

    svg += renderSchematicSlotComponent({
      comp: topComp,
      x: bx,
      yTop: 50,
      s1,
      s2,
      relayOn,
      topEnergized: true,
      botEnergized: topOut[b],
      interactive,
      builderMode,
      branch: b,
      slotType: 'topSlot'
    });

    svg += `<path d="M ${bx} 84 V 100" fill="none" stroke="${topOut[b] ? hotStroke : idleStroke}" stroke-width="2.6"/>`;
    svg += `<circle cx="${bx}" cy="100" r="${(b === 0 && schematic.bridge12) || (b === 1 && (schematic.bridge12 || schematic.bridge23)) || (b === 2 && schematic.bridge23) ? '4' : '2.5'}" fill="#0f172a"/>`;

    svg += `<path d="M ${bx} 100 V 114" fill="none" stroke="${topOut[b] ? hotStroke : idleStroke}" stroke-width="2.6"/>`;

    svg += renderSchematicSlotComponent({
      comp: midComp,
      x: bx,
      yTop: 114,
      s1,
      s2,
      relayOn,
      topEnergized: topOut[b],
      botEnergized: midOut[b],
      interactive,
      builderMode,
      branch: b,
      slotType: 'midSlot'
    });

    svg += `<path d="M ${bx} 148 V 178" fill="none" stroke="${midOut[b] ? hotStroke : idleStroke}" stroke-width="2.6"/>`;

    svg += renderSchematicLoadComponent({
      load: loadComp,
      x: bx,
      yCenter: 194,
      energized: midOut[b],
      l1,
      l2,
      relayOn,
      builderMode,
      branch: b
    });

    if (loadComp || builderMode) {
      svg += `<path d="M ${bx} 210 V 236" fill="none" stroke="${gndStroke}" stroke-width="2.6"/>`;
      svg += `<circle cx="${bx}" cy="236" r="4" fill="#0f172a"/>`;
    }
  }

  // Draw Parallel Bridges
  if (schematic.bridge12 || builderMode) {
    const isHot12 = topOut[0] || topOut[1];
    const bridgeStroke = schematic.bridge12 ? (isHot12 ? hotStroke : idleStroke) : '#334155';
    const bridgeDash = schematic.bridge12 ? 'none' : '3 3';
    svg += `
      <g class="bridge-line-group" data-bridge="12">
        <path d="M 85 100 H 195" fill="none" stroke="${bridgeStroke}" stroke-width="2.6" stroke-dasharray="${bridgeDash}"/>
      </g>
    `;
  }

  if (schematic.bridge23 || builderMode) {
    const isHot23 = topOut[1] || topOut[2];
    const bridgeStroke = schematic.bridge23 ? (isHot23 ? hotStroke : idleStroke) : '#334155';
    const bridgeDash = schematic.bridge23 ? 'none' : '3 3';
    svg += `
      <g class="bridge-line-group" data-bridge="23">
        <path d="M 195 100 H 305" fill="none" stroke="${bridgeStroke}" stroke-width="2.6" stroke-dasharray="${bridgeDash}"/>
      </g>
    `;
  }

  // Bottom Rail: 0V
  svg += `
      <path d="M 41 236 H 305" fill="none" stroke="${gndStroke}" stroke-width="2.8"/>
      <circle cx="36" cy="236" r="5" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>
      <text x="18" y="224" font-size="13" font-weight="700" fill="#0f172a">0V</text>

      <!-- Watermark & Branding -->
      <text x="180" y="140" text-anchor="middle" fill="#64748b" opacity="0.14" font-size="26" font-weight="900" transform="rotate(-18, 180, 140)" pointer-events="none">Kru-Jirawat</text>
      <text x="352" y="250" text-anchor="end" fill="#64748b" opacity="0.55" font-size="9.5" font-weight="700" pointer-events="none">Kru-Jirawat</text>
    </svg>
  `;

  return svg;
}

// Render Dynamic Schematic Diagram based on current lab & live simulation state
function renderSchematic() {
  const container = document.getElementById('schematicContainer');
  const lab = LABS[state.currentLabId];
  const s1 = state.switches.S1.pressed;
  const s2 = state.switches.S2.pressed;
  const l1 = state.simResult.L1;
  const l2 = state.simResult.L2;
  const relayOn = state.simResult.K1 || state.simResult.K2;

  const pwr = Boolean(state.powerOn && !state.simResult.shortCircuit);
  const hotStroke = pwr ? '#ef4444' : '#475569';
  const gndStroke = pwr ? '#3b82f6' : '#475569';
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
  } else if (state.currentLabId === 'lab4_1') {
    const spec = getPlcModelSpec();
    const hasWires = state.wires.length > 0;
    const f1Blown = Boolean(state.fuseBlown && state.fuseBlown.F1);
    const logicMode = (hasWires && state.simResult && state.simResult.detectedInputLogic)
      ? state.simResult.detectedInputLogic
      : (state.plcWiringLogic || 'negative');
    const isPos = logicMode === 'positive';

    const in0Active = hasWires ? Boolean(state.simResult.plcInputs && state.simResult.plcInputs[0]) : (pwr && !f1Blown && s1);
    const fuse1Stroke = (!f1Blown && pwr) ? hotStroke : idleStroke;

    const fuse1Svg = f1Blown
      ? `<rect x="88" y="60" width="24" height="42" rx="4" fill="#450a0a" stroke="#ef4444" stroke-width="2"/>
         <text x="100" y="85" text-anchor="middle" font-size="9" font-weight="800" fill="#fca5a5">💥ขาด</text>`
      : `<rect x="88" y="60" width="24" height="42" rx="4" fill="#f0f9ff" stroke="#0284c7" stroke-width="2"/>
         <line x1="100" y1="64" x2="100" y2="98" stroke="#ef4444" stroke-width="1.8" stroke-dasharray="2 2"/>
         <text x="100" y="85" text-anchor="middle" font-size="11" font-weight="800" fill="#0369a1">F1</text>`;

    const badgeSvg = `
      <rect x="75" y="8" width="210" height="20" rx="10" fill="${isPos ? '#064e3b' : '#1e3a8a'}" stroke="${isPos ? '#10b981' : '#3b82f6'}" stroke-width="1.2"/>
      <text x="180" y="22" text-anchor="middle" font-size="9.5" font-weight="700" fill="#ffffff">${isPos ? 'Positive Logic (COM = 0V Sink)' : 'Negative Logic (COM = +24V Source)'}</text>
    `;

    if (!isPos) {
      // Negative Logic (Source Input: COM = +24V, S1 pulls to 0V)
      svgContent = `
        <svg viewBox="0 0 360 270">
          ${badgeSvg}
          <text x="25" y="44" font-size="13" font-weight="700" fill="#dc2626">+24VDC</text>
          <circle cx="45" cy="56" r="6" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
          <text x="25" y="254" font-size="13" font-weight="700" fill="#0f172a">0V</text>
          <circle cx="45" cy="242" r="6" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>

          <!-- +24V to Fuse F1 to COM -->
          <path d="M51 56 H100 V60" fill="none" stroke="${hotStroke}" stroke-width="3"/>
          ${fuse1Svg}
          <path d="M100 102 V130 H155" fill="none" stroke="${fuse1Stroke}" stroke-width="3"/>

          <!-- 0V line to Switch S1 NO to I0.0 / X0 -->
          <path d="M51 242 H100 V205" fill="none" stroke="${gndStroke}" stroke-width="3"/>
          ${drawIECSwitchNO({
            id: 'S1',
            label: 'S1 (3-4)',
            x: 100,
            yTop: 165,
            pressed: s1,
            topEnergized: in0Active,
            bottomEnergized: pwr
          })}
          <path d="M100 165 V155 H155" fill="none" stroke="${in0Active ? gndStroke : idleStroke}" stroke-width="3"/>

          <!-- PLC Block -->
          <rect x="155" y="42" width="185" height="195" rx="8" fill="#0f172a" stroke="#38bdf8" stroke-width="2"/>
          <rect x="155" y="42" width="185" height="26" rx="8" fill="#1e293b"/>
          <text x="247" y="60" text-anchor="middle" font-size="11" font-weight="700" fill="#38bdf8">${spec.shortName} INPUTS</text>

          <circle cx="155" cy="130" r="5" fill="${fuse1Stroke === hotStroke ? '#ef4444' : '#475569'}"/>
          <text x="166" y="134" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="700" fill="#f8fafc">${spec.inCom}</text>
          <text x="210" y="134" font-size="9" fill="#94a3b8">(+24V Source)</text>

          <circle cx="155" cy="155" r="5" fill="${in0Active ? '#22c55e' : '#475569'}"/>
          <text x="166" y="159" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="700" fill="${in0Active ? '#4ade80' : '#cbd5e1'}">${spec.termInShort(0)}</text>
          <circle cx="218" cy="155" r="4" fill="${in0Active ? '#22c55e' : '#334155'}"/>
          <text x="228" y="159" font-size="9.5" font-weight="600" fill="${in0Active ? '#4ade80' : '#64748b'}">${in0Active ? 'ACTIVE (1)' : 'OFF (0)'}</text>

          <rect x="168" y="178" width="160" height="46" rx="5" fill="#1e293b" stroke="#334155" stroke-width="1"/>
          <text x="248" y="193" text-anchor="middle" font-size="9" font-weight="700" fill="#94a3b8">LADDER CO-SIM OUTPUTS</text>
          <text x="180" y="212" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="${l1 ? '#4ade80' : '#64748b'}">${spec.termOutShort(0)}: ${l1 ? 'ON' : 'OFF'}</text>
          <text x="250" y="212" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="${l2 ? '#4ade80' : '#64748b'}">${spec.termOutShort(1)}: ${l2 ? 'ON' : 'OFF'}</text>
        </svg>
      `;
    } else {
      // Positive Logic (Sink Input: COM = 0V, S1 sends +24V through F1)
      svgContent = `
        <svg viewBox="0 0 360 270">
          ${badgeSvg}
          <text x="25" y="44" font-size="13" font-weight="700" fill="#dc2626">+24VDC</text>
          <circle cx="45" cy="56" r="6" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
          <text x="25" y="254" font-size="13" font-weight="700" fill="#0f172a">0V</text>
          <circle cx="45" cy="242" r="6" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>

          <!-- +24V to Fuse F1 to S1 NO to I0.0 / X0 -->
          <path d="M51 56 H100 V60" fill="none" stroke="${hotStroke}" stroke-width="3"/>
          ${fuse1Svg}
          <path d="M100 102 V118" fill="none" stroke="${fuse1Stroke}" stroke-width="3"/>
          ${drawIECSwitchNO({
            id: 'S1',
            label: 'S1 (3-4)',
            x: 100,
            yTop: 118,
            pressed: s1,
            topEnergized: fuse1Stroke === hotStroke,
            bottomEnergized: in0Active
          })}
          <path d="M100 152 V155 H155" fill="none" stroke="${in0Active ? hotStroke : idleStroke}" stroke-width="3"/>

          <!-- 0V line to COM (0V Sink) -->
          <path d="M51 242 H130 V130 H155" fill="none" stroke="${gndStroke}" stroke-width="3"/>

          <!-- PLC Block -->
          <rect x="155" y="42" width="185" height="195" rx="8" fill="#0f172a" stroke="#38bdf8" stroke-width="2"/>
          <rect x="155" y="42" width="185" height="26" rx="8" fill="#1e293b"/>
          <text x="247" y="60" text-anchor="middle" font-size="11" font-weight="700" fill="#38bdf8">${spec.shortName} INPUTS</text>

          <circle cx="155" cy="130" r="5" fill="#3b82f6"/>
          <text x="166" y="134" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="700" fill="#f8fafc">${spec.inCom}</text>
          <text x="210" y="134" font-size="9" fill="#94a3b8">(0V Sink)</text>

          <circle cx="155" cy="155" r="5" fill="${in0Active ? '#22c55e' : '#475569'}"/>
          <text x="166" y="159" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="700" fill="${in0Active ? '#4ade80' : '#cbd5e1'}">${spec.termInShort(0)}</text>
          <circle cx="218" cy="155" r="4" fill="${in0Active ? '#22c55e' : '#334155'}"/>
          <text x="228" y="159" font-size="9.5" font-weight="600" fill="${in0Active ? '#4ade80' : '#64748b'}">${in0Active ? 'ACTIVE (1)' : 'OFF (0)'}</text>

          <rect x="168" y="178" width="160" height="46" rx="5" fill="#1e293b" stroke="#334155" stroke-width="1"/>
          <text x="248" y="193" text-anchor="middle" font-size="9" font-weight="700" fill="#94a3b8">LADDER CO-SIM OUTPUTS</text>
          <text x="180" y="212" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="${l1 ? '#4ade80' : '#64748b'}">${spec.termOutShort(0)}: ${l1 ? 'ON' : 'OFF'}</text>
          <text x="250" y="212" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="${l2 ? '#4ade80' : '#64748b'}">${spec.termOutShort(1)}: ${l2 ? 'ON' : 'OFF'}</text>
        </svg>
      `;
    }
  } else if (state.currentLabId === 'lab4_2') {
    const spec = getPlcModelSpec();
    const hasWires = state.wires.length > 0;
    const f1Blown = Boolean(state.fuseBlown && state.fuseBlown.F1);
    const logicMode = (hasWires && state.simResult && state.simResult.detectedInputLogic)
      ? state.simResult.detectedInputLogic
      : (state.plcWiringLogic || 'negative');
    const isPos = logicMode === 'positive';

    const in0Active = hasWires ? Boolean(state.simResult.plcInputs && state.simResult.plcInputs[0]) : (pwr && !f1Blown && s1);
    const in1Active = hasWires ? Boolean(state.simResult.plcInputs && state.simResult.plcInputs[1]) : (pwr && !f1Blown && s2);
    const fuse1Stroke = (!f1Blown && pwr) ? hotStroke : idleStroke;

    const fuse1Svg = f1Blown
      ? `<rect x="73" y="55" width="24" height="38" rx="4" fill="#450a0a" stroke="#ef4444" stroke-width="2"/>
         <text x="85" y="78" text-anchor="middle" font-size="9" font-weight="800" fill="#fca5a5">💥ขาด</text>`
      : `<rect x="73" y="55" width="24" height="38" rx="4" fill="#f0f9ff" stroke="#0284c7" stroke-width="2"/>
         <line x1="85" y1="59" x2="85" y2="89" stroke="#ef4444" stroke-width="1.8" stroke-dasharray="2 2"/>
         <text x="85" y="78" text-anchor="middle" font-size="11" font-weight="800" fill="#0369a1">F1</text>`;

    const badgeSvg = `
      <rect x="75" y="8" width="210" height="20" rx="10" fill="${isPos ? '#064e3b' : '#1e3a8a'}" stroke="${isPos ? '#10b981' : '#3b82f6'}" stroke-width="1.2"/>
      <text x="180" y="22" text-anchor="middle" font-size="9.5" font-weight="700" fill="#ffffff">${isPos ? 'Positive Logic (COM = 0V Sink)' : 'Negative Logic (COM = +24V Source)'}</text>
    `;

    if (!isPos) {
      // Negative Logic (COM = +24V via F1, S1/S2 pull to 0V)
      svgContent = `
        <svg viewBox="0 0 360 270">
          ${badgeSvg}
          <text x="20" y="38" font-size="13" font-weight="700" fill="#dc2626">+24VDC</text>
          <circle cx="40" cy="50" r="6" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
          <text x="20" y="258" font-size="13" font-weight="700" fill="#0f172a">0V</text>
          <circle cx="40" cy="246" r="6" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>

          <!-- +24V to Fuse F1 to COM -->
          <path d="M46 50 H85 V55" fill="none" stroke="${hotStroke}" stroke-width="3"/>
          ${fuse1Svg}
          <path d="M85 93 V118 H155" fill="none" stroke="${fuse1Stroke}" stroke-width="3"/>

          <!-- 0V to S1 & S2 -->
          <path d="M46 246 H115 V215 M70 246 V215" fill="none" stroke="${gndStroke}" stroke-width="3"/>
          ${drawIECSwitchNO({
            id: 'S1',
            label: 'S1',
            x: 70,
            yTop: 175,
            pressed: s1,
            topEnergized: in0Active,
            bottomEnergized: pwr
          })}
          <path d="M70 175 V145 H155" fill="none" stroke="${in0Active ? gndStroke : idleStroke}" stroke-width="3"/>

          ${drawIECSwitchNO({
            id: 'S2',
            label: 'S2',
            x: 115,
            yTop: 175,
            pressed: s2,
            topEnergized: in1Active,
            bottomEnergized: pwr
          })}
          <path d="M115 175 V168 H155" fill="none" stroke="${in1Active ? gndStroke : idleStroke}" stroke-width="3"/>

          <!-- PLC Block -->
          <rect x="155" y="38" width="185" height="202" rx="8" fill="#0f172a" stroke="#38bdf8" stroke-width="2"/>
          <rect x="155" y="38" width="185" height="26" rx="8" fill="#1e293b"/>
          <text x="247" y="56" text-anchor="middle" font-size="11" font-weight="700" fill="#38bdf8">${spec.shortName} AND LOGIC</text>

          <circle cx="155" cy="118" r="5" fill="${fuse1Stroke === hotStroke ? '#ef4444' : '#475569'}"/>
          <text x="166" y="122" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="700" fill="#f8fafc">${spec.inCom}</text>

          <circle cx="155" cy="145" r="5" fill="${in0Active ? '#22c55e' : '#475569'}"/>
          <text x="166" y="149" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="700" fill="${in0Active ? '#4ade80' : '#cbd5e1'}">${spec.termInShort(0)} (S1)</text>

          <circle cx="155" cy="168" r="5" fill="${in1Active ? '#22c55e' : '#475569'}"/>
          <text x="166" y="172" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="700" fill="${in1Active ? '#4ade80' : '#cbd5e1'}">${spec.termInShort(1)} (S2)</text>

          <rect x="168" y="188" width="160" height="40" rx="5" fill="#1e293b" stroke="#334155" stroke-width="1"/>
          <text x="248" y="203" text-anchor="middle" font-size="9" font-weight="700" fill="#94a3b8">AND OUTPUT: S1 ∧ S2</text>
          <text x="248" y="220" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="800" fill="${l1 ? '#4ade80' : '#64748b'}">${spec.termOutShort(0)}: ${l1 ? 'ON (1)' : 'OFF (0)'}</text>
        </svg>
      `;
    } else {
      // Positive Logic (COM = 0V, S1 & S2 fed +24V through F1)
      svgContent = `
        <svg viewBox="0 0 360 270">
          ${badgeSvg}
          <text x="20" y="38" font-size="13" font-weight="700" fill="#dc2626">+24VDC</text>
          <circle cx="40" cy="50" r="6" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
          <text x="20" y="258" font-size="13" font-weight="700" fill="#0f172a">0V</text>
          <circle cx="40" cy="246" r="6" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>

          <!-- +24V to Fuse F1 to S1 & S2 NO contacts -->
          <path d="M46 50 H85 V55" fill="none" stroke="${hotStroke}" stroke-width="3"/>
          ${fuse1Svg}
          <path d="M85 93 V105 H65 V115 M85 105 H110 V115" fill="none" stroke="${fuse1Stroke}" stroke-width="3"/>
          ${drawIECSwitchNO({
            id: 'S1',
            label: 'S1',
            x: 65,
            yTop: 115,
            pressed: s1,
            topEnergized: fuse1Stroke === hotStroke,
            bottomEnergized: in0Active
          })}
          <path d="M65 149 V145 H155" fill="none" stroke="${in0Active ? hotStroke : idleStroke}" stroke-width="3"/>

          ${drawIECSwitchNO({
            id: 'S2',
            label: 'S2',
            x: 110,
            yTop: 115,
            pressed: s2,
            topEnergized: fuse1Stroke === hotStroke,
            bottomEnergized: in1Active
          })}
          <path d="M110 149 V168 H155" fill="none" stroke="${in1Active ? hotStroke : idleStroke}" stroke-width="3"/>

          <!-- 0V to COM (0V Sink) -->
          <path d="M46 246 H135 V118 H155" fill="none" stroke="${gndStroke}" stroke-width="3"/>

          <!-- PLC Block -->
          <rect x="155" y="38" width="185" height="202" rx="8" fill="#0f172a" stroke="#38bdf8" stroke-width="2"/>
          <rect x="155" y="38" width="185" height="26" rx="8" fill="#1e293b"/>
          <text x="247" y="56" text-anchor="middle" font-size="11" font-weight="700" fill="#38bdf8">${spec.shortName} AND LOGIC</text>

          <circle cx="155" cy="118" r="5" fill="#3b82f6"/>
          <text x="166" y="122" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="700" fill="#f8fafc">${spec.inCom}</text>
          <text x="210" y="122" font-size="9" fill="#94a3b8">(0V Sink)</text>

          <circle cx="155" cy="145" r="5" fill="${in0Active ? '#22c55e' : '#475569'}"/>
          <text x="166" y="149" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="700" fill="${in0Active ? '#4ade80' : '#cbd5e1'}">${spec.termInShort(0)} (S1)</text>

          <circle cx="155" cy="168" r="5" fill="${in1Active ? '#22c55e' : '#475569'}"/>
          <text x="166" y="172" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="700" fill="${in1Active ? '#4ade80' : '#cbd5e1'}">${spec.termInShort(1)} (S2)</text>

          <rect x="168" y="188" width="160" height="40" rx="5" fill="#1e293b" stroke="#334155" stroke-width="1"/>
          <text x="248" y="203" text-anchor="middle" font-size="9" font-weight="700" fill="#94a3b8">AND OUTPUT: S1 ∧ S2</text>
          <text x="248" y="220" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="800" fill="${l1 ? '#4ade80' : '#64748b'}">${spec.termOutShort(0)}: ${l1 ? 'ON (1)' : 'OFF (0)'}</text>
        </svg>
      `;
    }
  } else if (state.currentLabId === 'lab5_1') {
    const spec = getPlcModelSpec();
    const hasWires = state.wires.length > 0;
    const f1Blown = Boolean(state.fuseBlown && state.fuseBlown.F1);
    const f2Blown = Boolean(state.fuseBlown && state.fuseBlown.F2);
    const logicMode = (hasWires && state.simResult && state.simResult.detectedInputLogic)
      ? state.simResult.detectedInputLogic
      : (state.plcWiringLogic || 'negative');
    const isPos = logicMode === 'positive';

    const in0Active = hasWires ? Boolean(state.simResult.plcInputs && state.simResult.plcInputs[0]) : (pwr && !f1Blown && s1);
    const fuse1Stroke = (!f1Blown && pwr) ? hotStroke : idleStroke;
    const fuse2Stroke = (!f2Blown && pwr) ? hotStroke : idleStroke;

    const fuse1Svg = f1Blown
      ? `<rect x="68" y="55" width="24" height="36" rx="4" fill="#450a0a" stroke="#ef4444" stroke-width="1.8"/>
         <text x="80" y="77" text-anchor="middle" font-size="9" font-weight="800" fill="#fca5a5">💥ขาด</text>`
      : `<rect x="68" y="55" width="24" height="36" rx="4" fill="#f0f9ff" stroke="#0284c7" stroke-width="1.8"/>
         <line x1="80" y1="59" x2="80" y2="87" stroke="#ef4444" stroke-width="1.8" stroke-dasharray="2 2"/>
         <text x="80" y="77" text-anchor="middle" font-size="10.5" font-weight="800" fill="#0369a1">F1</text>`;

    const fuse2Svg = f2Blown
      ? `<rect x="298" y="55" width="24" height="36" rx="4" fill="#450a0a" stroke="#ef4444" stroke-width="1.8"/>
         <text x="310" y="77" text-anchor="middle" font-size="9" font-weight="800" fill="#fca5a5">💥ขาด</text>`
      : `<rect x="298" y="55" width="24" height="36" rx="4" fill="#f0f9ff" stroke="#0284c7" stroke-width="1.8"/>
         <line x1="310" y1="59" x2="310" y2="87" stroke="#ef4444" stroke-width="1.8" stroke-dasharray="2 2"/>
         <text x="310" y="77" text-anchor="middle" font-size="10.5" font-weight="800" fill="#0369a1">F2</text>`;

    const badgeSvg = `
      <rect x="75" y="8" width="210" height="20" rx="10" fill="${isPos ? '#064e3b' : '#1e3a8a'}" stroke="${isPos ? '#10b981' : '#3b82f6'}" stroke-width="1.2"/>
      <text x="180" y="22" text-anchor="middle" font-size="9.5" font-weight="700" fill="#ffffff">${isPos ? 'Positive Logic (COM = 0V Sink)' : 'Negative Logic (COM = +24V Source)'}</text>
    `;

    svgContent = `
      <svg viewBox="0 0 360 270">
        ${badgeSvg}
        <text x="20" y="36" font-size="13" font-weight="700" fill="#dc2626">+24VDC</text>
        <circle cx="38" cy="48" r="6" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
        <text x="20" y="258" font-size="13" font-weight="700" fill="#0f172a">0V</text>
        <circle cx="38" cy="246" r="6" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>

        <!-- Input wiring -->
        ${!isPos ? `
          <path d="M44 48 H80 V55" fill="none" stroke="${hotStroke}" stroke-width="3"/>
          ${fuse1Svg}
          <path d="M80 91 V110 H135" fill="none" stroke="${fuse1Stroke}" stroke-width="3"/>
          <path d="M44 246 H80 V210" fill="none" stroke="${gndStroke}" stroke-width="3"/>
          ${drawIECSwitchNO({
            id: 'S1',
            label: 'PB1',
            x: 80,
            yTop: 168,
            pressed: s1,
            topEnergized: in0Active,
            bottomEnergized: pwr
          })}
          <path d="M80 168 V140 H135" fill="none" stroke="${in0Active ? gndStroke : idleStroke}" stroke-width="3"/>
        ` : `
          <path d="M44 48 H80 V55" fill="none" stroke="${hotStroke}" stroke-width="3"/>
          ${fuse1Svg}
          <path d="M80 91 V118" fill="none" stroke="${fuse1Stroke}" stroke-width="3"/>
          ${drawIECSwitchNO({
            id: 'S1',
            label: 'PB1',
            x: 80,
            yTop: 118,
            pressed: s1,
            topEnergized: fuse1Stroke === hotStroke,
            bottomEnergized: in0Active
          })}
          <path d="M80 152 V140 H135" fill="none" stroke="${in0Active ? hotStroke : idleStroke}" stroke-width="3"/>
          <path d="M44 246 H110 V110 H135" fill="none" stroke="${gndStroke}" stroke-width="3"/>
        `}

        <!-- PLC Block -->
        <rect x="135" y="38" width="125" height="192" rx="8" fill="#0f172a" stroke="#38bdf8" stroke-width="2"/>
        <text x="197" y="56" text-anchor="middle" font-size="11" font-weight="700" fill="#38bdf8">${spec.shortName}</text>
        <text x="145" y="80" font-size="9" fill="#94a3b8">INPUTS</text>
        <circle cx="135" cy="110" r="5" fill="${!isPos ? (fuse1Stroke === hotStroke ? '#ef4444' : '#475569') : '#3b82f6'}"/>
        <text x="145" y="114" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="#fff">${spec.inCom}</text>
        <circle cx="135" cy="140" r="5" fill="${in0Active ? '#22c55e' : '#475569'}"/>
        <text x="145" y="144" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="${in0Active ? '#4ade80' : '#cbd5e1'}">${spec.termInShort(0)}</text>

        <text x="215" y="80" font-size="9" fill="#94a3b8">OUTPUTS</text>
        <circle cx="260" cy="110" r="5" fill="${fuse2Stroke === hotStroke ? '#ef4444' : '#475569'}"/>
        <text x="220" y="114" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="#fff">COM0</text>
        <circle cx="260" cy="140" r="5" fill="${l1 ? '#facc15' : '#475569'}"/>
        <text x="232" y="144" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="${l1 ? '#fde047' : '#cbd5e1'}">${spec.termOutShort(0)}</text>

        <!-- Output side wiring: +24V -> F2 -> COM0 -->
        <path d="M44 48 H310 V55" fill="none" stroke="${hotStroke}" stroke-width="3"/>
        ${fuse2Svg}
        <path d="M310 91 V110 H260" fill="none" stroke="${fuse2Stroke}" stroke-width="3"/>

        <!-- Q0 -> PL1 (Red) -> 0V -->
        <path d="M260 140 H310 V165" fill="none" stroke="${l1 ? hotStroke : idleStroke}" stroke-width="3"/>
        <circle cx="310" cy="180" r="14" fill="${l1 ? '#ef4444' : '#7f1d1d'}" stroke="#0f172a" stroke-width="2"/>
        <path d="M300 170 L320 190 M320 170 L300 190" stroke="#fff" stroke-width="2"/>
        <text x="330" y="184" font-size="11" font-weight="700" fill="#dc2626">PL1</text>
        <path d="M310 194 V246 H44" fill="none" stroke="${gndStroke}" stroke-width="3"/>
      </svg>
    `;
  } else if (state.currentLabId === 'lab5_2') {
    const spec = getPlcModelSpec();
    const hasWires = state.wires.length > 0;
    const f1Blown = Boolean(state.fuseBlown && state.fuseBlown.F1);
    const f2Blown = Boolean(state.fuseBlown && state.fuseBlown.F2);
    const logicMode = (hasWires && state.simResult && state.simResult.detectedInputLogic)
      ? state.simResult.detectedInputLogic
      : (state.plcWiringLogic || 'negative');
    const isPos = logicMode === 'positive';

    const in0Active = hasWires ? Boolean(state.simResult.plcInputs && state.simResult.plcInputs[0]) : (pwr && !f1Blown && s1);
    const fuse1Stroke = (!f1Blown && pwr) ? hotStroke : idleStroke;
    const fuse2Stroke = (!f2Blown && pwr) ? hotStroke : idleStroke;

    const fuse1Svg = f1Blown
      ? `<rect x="64" y="48" width="22" height="34" rx="4" fill="#450a0a" stroke="#ef4444" stroke-width="1.8"/>
         <text x="75" y="70" text-anchor="middle" font-size="8.5" font-weight="800" fill="#fca5a5">💥ขาด</text>`
      : `<rect x="64" y="48" width="22" height="34" rx="4" fill="#f0f9ff" stroke="#0284c7" stroke-width="1.8"/>
         <line x1="75" y1="52" x2="75" y2="78" stroke="#ef4444" stroke-width="1.8" stroke-dasharray="2 2"/>
         <text x="75" y="70" text-anchor="middle" font-size="10" font-weight="800" fill="#0369a1">F1</text>`;

    const fuse2Svg = f2Blown
      ? `<rect x="284" y="48" width="22" height="34" rx="4" fill="#450a0a" stroke="#ef4444" stroke-width="1.8"/>
         <text x="295" y="70" text-anchor="middle" font-size="8.5" font-weight="800" fill="#fca5a5">💥ขาด</text>`
      : `<rect x="284" y="48" width="22" height="34" rx="4" fill="#f0f9ff" stroke="#0284c7" stroke-width="1.8"/>
         <line x1="295" y1="52" x2="295" y2="78" stroke="#ef4444" stroke-width="1.8" stroke-dasharray="2 2"/>
         <text x="295" y="70" text-anchor="middle" font-size="10" font-weight="800" fill="#0369a1">F2</text>`;

    const badgeSvg = `
      <rect x="75" y="8" width="210" height="20" rx="10" fill="${isPos ? '#064e3b' : '#1e3a8a'}" stroke="${isPos ? '#10b981' : '#3b82f6'}" stroke-width="1.2"/>
      <text x="180" y="22" text-anchor="middle" font-size="9.5" font-weight="700" fill="#ffffff">${isPos ? 'Positive Logic (COM = 0V Sink)' : 'Negative Logic (COM = +24V Source)'}</text>
    `;

    svgContent = `
      <svg viewBox="0 0 360 270">
        ${badgeSvg}
        <text x="15" y="34" font-size="12" font-weight="700" fill="#dc2626">+24VDC</text>
        <circle cx="35" cy="46" r="5" fill="#fff" stroke="#dc2626" stroke-width="2.5"/>
        <text x="15" y="260" font-size="12" font-weight="700" fill="#0f172a">0V</text>
        <circle cx="35" cy="248" r="5" fill="#fff" stroke="#0f172a" stroke-width="2.5"/>

        <!-- Input side wiring -->
        ${!isPos ? `
          <path d="M40 46 H75 V48" fill="none" stroke="${hotStroke}" stroke-width="2.5"/>
          ${fuse1Svg}
          <path d="M75 82 V108 H125" fill="none" stroke="${fuse1Stroke}" stroke-width="2.5"/>
          <path d="M40 248 H75 V200" fill="none" stroke="${gndStroke}" stroke-width="2.5"/>
          ${drawIECSwitchNO({
            id: 'S1',
            label: 'PB1',
            x: 75,
            yTop: 160,
            pressed: s1,
            topEnergized: in0Active,
            bottomEnergized: pwr
          })}
          <path d="M75 160 V136 H125" fill="none" stroke="${in0Active ? gndStroke : idleStroke}" stroke-width="2.5"/>
        ` : `
          <path d="M40 46 H75 V48" fill="none" stroke="${hotStroke}" stroke-width="2.5"/>
          ${fuse1Svg}
          <path d="M75 82 V115" fill="none" stroke="${fuse1Stroke}" stroke-width="2.5"/>
          ${drawIECSwitchNO({
            id: 'S1',
            label: 'PB1',
            x: 75,
            yTop: 115,
            pressed: s1,
            topEnergized: fuse1Stroke === hotStroke,
            bottomEnergized: in0Active
          })}
          <path d="M75 149 V136 H125" fill="none" stroke="${in0Active ? hotStroke : idleStroke}" stroke-width="2.5"/>
          <path d="M40 248 H105 V108 H125" fill="none" stroke="${gndStroke}" stroke-width="2.5"/>
        `}

        <!-- PLC Block -->
        <rect x="125" y="32" width="130" height="203" rx="8" fill="#0f172a" stroke="#38bdf8" stroke-width="2"/>
        <text x="190" y="50" text-anchor="middle" font-size="11" font-weight="700" fill="#38bdf8">${spec.shortName}</text>
        <circle cx="125" cy="108" r="5" fill="${!isPos ? (fuse1Stroke === hotStroke ? '#ef4444' : '#475569') : '#3b82f6'}"/>
        <text x="135" y="112" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="#fff">${spec.inCom}</text>
        <circle cx="125" cy="136" r="5" fill="${in0Active ? '#22c55e' : '#475569'}"/>
        <text x="135" y="140" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="${in0Active ? '#4ade80' : '#cbd5e1'}">${spec.termInShort(0)}</text>

        <circle cx="255" cy="108" r="5" fill="${fuse2Stroke === hotStroke ? '#ef4444' : '#475569'}"/>
        <text x="215" y="112" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="#fff">COM0</text>
        <circle cx="255" cy="136" r="5" fill="${l1 ? '#facc15' : '#475569'}"/>
        <text x="225" y="140" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="${l1 ? '#fde047' : '#cbd5e1'}">${spec.termOutShort(0)}</text>
        <circle cx="255" cy="164" r="5" fill="${l2 ? '#4ade80' : '#475569'}"/>
        <text x="225" y="168" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="${l2 ? '#4ade80' : '#cbd5e1'}">${spec.termOutShort(1)}</text>

        <!-- F2 to COM0 -->
        <path d="M40 46 H295 V48" fill="none" stroke="${hotStroke}" stroke-width="2.5"/>
        ${fuse2Svg}
        <path d="M295 82 V108 H255" fill="none" stroke="${fuse2Stroke}" stroke-width="2.5"/>

        <!-- Q0 -> PL1 (Red) -->
        <path d="M255 136 H295 V155" fill="none" stroke="${l1 ? hotStroke : idleStroke}" stroke-width="2.5"/>
        <circle cx="295" cy="168" r="12" fill="${l1 ? '#ef4444' : '#7f1d1d'}" stroke="#0f172a" stroke-width="2"/>
        <path d="M287 160 L303 176 M303 160 L287 176" stroke="#fff" stroke-width="1.8"/>
        <text x="314" y="172" font-size="10.5" font-weight="700" fill="#dc2626">PL1</text>

        <!-- Q1 -> PL2 (Green) -->
        <path d="M255 164 H340 V195" fill="none" stroke="${l2 ? '#22c55e' : idleStroke}" stroke-width="2.5"/>
        <circle cx="340" cy="208" r="12" fill="${l2 ? '#22c55e' : '#064e3b'}" stroke="#0f172a" stroke-width="2"/>
        <path d="M332 200 L348 216 M348 200 L332 216" stroke="#fff" stroke-width="1.8"/>
        <text x="314" y="222" font-size="10.5" font-weight="700" fill="#16a34a">PL2</text>

        <!-- Lamps return to 0V -->
        <path d="M295 180 V248 M340 220 V248 H40" fill="none" stroke="${gndStroke}" stroke-width="2.5"/>
      </svg>
    `;
  } else if (lab && lab.customSchematic) {
    svgContent = generateCustomSchematicSvg(lab.customSchematic, {
      s1,
      s2,
      l1,
      l2,
      relayOn,
      interactive: true,
      builderMode: false
    });
  }

  if (svgContent && !svgContent.includes('Kru-Jirawat')) {
    const wmSvg = `
      <text x="180" y="140" text-anchor="middle" fill="#64748b" opacity="0.14" font-size="26" font-weight="900" transform="rotate(-18, 180, 140)" pointer-events="none">Kru-Jirawat</text>
      <text x="352" y="250" text-anchor="end" fill="#64748b" opacity="0.55" font-size="9.5" font-weight="700" pointer-events="none">Kru-Jirawat</text>
    `;
    svgContent = svgContent.replace('</svg>', `${wmSvg}</svg>`);
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
  const isPlc = Boolean(lab.isPlcTerminalLab);
  const spec = isPlc ? getPlcModelSpec() : null;

  lab.inputs.forEach((inp) => {
    if (isPlc) {
      if (inp === 'S1') headers += `<th>S1 (${spec.termInShort(0)})</th>`;
      else if (inp === 'S2') headers += `<th>S2 (${spec.termInShort(1)})</th>`;
      else headers += `<th>${inp}</th>`;
    } else {
      headers += `<th>${inp}</th>`;
    }
  });
  if (lab.requireRelay) {
    headers += '<th>Coil Relay</th>';
  }
  lab.outputs.forEach((out) => {
    if (isPlc) {
      if (lab.plcInputOnlyLab) {
        if (out === 'L1') headers += `<th>ไฟสถานะ ${spec.termOutShort(0)} (บน Panel)</th>`;
        else if (out === 'L2') headers += `<th>ไฟสถานะ ${spec.termOutShort(1)} (บน Panel)</th>`;
        else headers += `<th>${out} (คาดหวัง)</th>`;
      } else {
        if (out === 'L1') headers += `<th>PL1 (${spec.termOutShort(0)}) คาดหวัง</th>`;
        else if (out === 'L2') headers += `<th>PL2 (${spec.termOutShort(1)}) คาดหวัง</th>`;
        else headers += `<th>${out} (คาดหวัง)</th>`;
      }
    } else {
      headers += `<th>${out === 'L1' && lab.outputs.length === 1 ? 'LOAD (L1)' : out} (คาดหวัง)</th>`;
    }
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
      applyTruthTableRow(rowIdx);
    });
  });
}

// Apply Truth Table Row Inputs to Simulation
function applyTruthTableRow(rowIdx) {
  const lab = LABS[state.currentLabId];
  if (!lab || !lab.truthTable || !lab.truthTable[rowIdx]) return;
  const row = lab.truthTable[rowIdx];

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
}

// Automated Circuit Verification Engine
function runAutomatedVerification() {
  const lab = LABS[state.currentLabId];
  const banner = document.getElementById('verificationMessage');
  const scoreBadge = document.getElementById('scoreBadge');
  const isPlcLab = Boolean(lab && lab.isPlcTerminalLab);

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
  let f1BlownDetected = false;
  let f2BlownDetected = false;
  let hasBypassedF1 = false;
  let hasBypassedF2 = false;
  let detectedLogic = null;
  let relayState = { K1: false, K2: false };

  lab.truthTable.forEach((testCase) => {
    const sim = evaluateCircuit({ S1: testCase.S1, S2: testCase.S2 }, relayState);
    relayState = { K1: sim.K1, K2: sim.K2 };

    if (sim.shortCircuit) {
      hasShortCircuit = true;
    }
    if (sim.fuseBlown) {
      if (sim.fuseBlown.F1) {
        f1BlownDetected = true;
        if (state.fuseBlown) state.fuseBlown.F1 = true;
      }
      if (sim.fuseBlown.F2) {
        f2BlownDetected = true;
        if (state.fuseBlown) state.fuseBlown.F2 = true;
      }
      if (sim.fuseBlown.MAIN) {
        if (state.fuseBlown) state.fuseBlown.MAIN = true;
      }
    }
    if (sim.bypassedF1) hasBypassedF1 = true;
    if (sim.bypassedF2) hasBypassedF2 = true;
    if (sim.detectedInputLogic) detectedLogic = sim.detectedInputLogic;

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

  if (hasShortCircuit || f1BlownDetected || f2BlownDetected) {
    updateSimulationUI();
  }

  renderTruthTable({ rows: rowResults });

  const passedCount = rowResults.filter((r) => r.passed).length;
  const totalCount = rowResults.length;
  const score = Math.round((passedCount / totalCount) * 10);

  if (hasShortCircuit) {
    banner.className = 'verification-banner error';
    let blownMsg = 'ตรวจพบการลัดวงจร (Short Circuit)!';
    if (isPlcLab) {
      const blownNames = [];
      if (f1BlownDetected) blownNames.push('F1 (ฝั่งอินพุต)');
      if (f2BlownDetected) blownNames.push('F2 (ฝั่งเอาต์พุต)');
      if (blownNames.length === 0) blownNames.push('F1 / F2');
      blownMsg = `💥 ฟิวส์ ${blownNames.join(' และ ')} ขาดเนื่องจากลัดวงจร! ตรวจพบสายไฟต่อตรงระหว่าง <b>+24V</b> และ <b>0V</b>`;
    } else {
      blownMsg = '💥 ฟิวส์หลักขาดเนื่องจากลัดวงจร! มีสายไฟต่อตรงระหว่าง <b>+12V</b> และ <b>0V (-)</b> โดยไม่ผ่านโหลดหรือคอยล์รีเลย์';
    }
    banner.innerHTML = `
      <div class="banner-icon">🚨</div>
      <div class="banner-text">
        <strong>${blownMsg}</strong><br/>
        <button type="button" onclick="resetFuses()" class="btn-reset-fuse" style="margin-top:6px;">🔄 คลิกเพื่อเปลี่ยน/รีเซตฟิวส์ใหม่</button>
      </div>
    `;
    scoreBadge.className = 'score-badge fail';
    scoreBadge.textContent = 'ลัดวงจร (0/10)';
  } else if (allPassed) {
    banner.className = 'verification-banner success';
    let logicSuccessNote = '';
    if (isPlcLab) {
      const modeText = (detectedLogic === 'positive')
        ? 'Positive Logic (Sink Input: COM = 0V)'
        : 'Negative Logic (Source Input: COM = +24V)';
      logicSuccessNote = `<br/>🌟 <b>รูปแบบวงจร:</b> ต่อวงจรแบบ ${modeText} ถูกต้องสมบูรณ์ตามมาตรฐาน`;
    }
    banner.innerHTML = `
      <div class="banner-icon">✅</div>
      <div class="banner-text">
        <strong>ยอดเยี่ยม! วงจรทำงานถูกต้องสมบูรณ์ 100%</strong><br/>
        ผ่านการทดสอบครบทุกเงื่อนไขของตารางความจริง (${passedCount}/${totalCount} เงื่อนไข) — เปรียบเทียบการทำงาน: <b>${lab.logicComparison}</b>
        ${logicSuccessNote}
      </div>
    `;
    scoreBadge.className = 'score-badge pass';
    scoreBadge.textContent = `ผ่าน (${score}/10 คะแนน)`;
  } else {
    let diagHint = 'ตรวจสอบการเลือกขั้ว NO / NC ของสวิตช์ และการต่อครบวงจรกลับไปยังขั้ว 0V (-)';
    if (hasBypassedF1 || hasBypassedF2) {
      diagHint = '⚠️ ตรวจพบการต่อสายข้ามฟิวส์ (FUSE): กรุณาต่อสายไฟเลี้ยงผ่านฟิวส์ F ตามวงจรสัญลักษณ์เพื่อความปลอดภัย';
    } else if (isPlcLab) {
      diagHint = (state.plcWiringLogic === 'positive')
        ? 'โหมด Positive Logic: ขั้ว COM ต้องต่อ 0V และสวิตช์ต้องรับไฟ +24V ผ่านฟิวส์ F1 เข้าสู่ Terminal I0.0 / I0.1'
        : 'โหมด Negative Logic: ขั้ว COM ต้องรับไฟ +24V ผ่านฟิวส์ F1 และสวิตช์ต้องต่อลง 0V เข้าสู่ Terminal I0.0 / I0.1';
    } else if (lab.requireRelay) {
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

  // Switch plunger green actuator boxes and indicator lamp bodies to avoid covering interactive buttons/lenses
  const switchBoxes = [
    { xMin: 214, xMax: 272, yMin: 235, yMax: 365 },
    { xMin: 214, xMax: 272, yMin: 430, yMax: 560 },
    { xMin: 585, xMax: 705, yMin: 70, yMax: 205 }, // PL1 (Red indicator lamp dome lens)
    { xMin: 740, xMax: 860, yMin: 70, yMax: 205 }  // PL2 (Green indicator lamp dome lens)
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

// ==========================================================================
// Real-Time Timing Diagram (ไดอะแกรมเส้นเวลา) Engine
// ==========================================================================

const timingState = {
  paused: false,
  windowSec: 15, // cycles 10 -> 15 -> 30
  startEpochMs: performance.now(),
  pausedAtMs: 0,
  totalPausedMs: 0,
  samples: [], // Array of { t: secondsFromStart, S1: 0|1, S2: 0|1, RELAY: 0|1, L1: 0|1, L2: 0|1 }
  transitions: [], // Array of { t: secondsFromStart, label: 'S1 ↑' | 'S1 ↓' | 'S2 ↑' | 'S2 ↓', color: string }
  lastSnap: null,
  hoverX: null,
  hoverY: null,
  autoPlayTimer: null,
  autoPlayStepIdx: 0,
  rafId: null
};

// Returns current seconds from start taking pauses into account
function getTimingNowSec() {
  const current = timingState.paused ? timingState.pausedAtMs : performance.now();
  return (current - timingState.startEpochMs - timingState.totalPausedMs) / 1000;
}

// Returns active channels for the current lab
function getTimingChannelsForCurrentLab() {
  const lab = (typeof state !== 'undefined' && state.currentLabId) ? LABS[state.currentLabId] : null;
  const spec = getPlcModelSpec();
  const channels = [];

  // S1 (Input) is always present
  channels.push({
    key: 'S1',
    name: `S1 (${spec.in0})`,
    shortName: `S1(${spec.in0})`,
    role: 'INPUT',
    color: '#22c55e',
    fill: 'rgba(34, 197, 94, 0.18)'
  });

  // S2 (Input)
  if (!lab || lab.showS2 || (lab.inputs && lab.inputs.includes('S2'))) {
    channels.push({
      key: 'S2',
      name: `S2 (${spec.in1})`,
      shortName: `S2(${spec.in1})`,
      role: 'INPUT',
      color: '#38bdf8',
      fill: 'rgba(56, 189, 248, 0.18)'
    });
  }

  // K1 (Coil Relay)
  if (lab && (lab.requireRelay || lab.showRelays)) {
    channels.push({
      key: 'RELAY',
      name: `K1 (${spec.mem0})`,
      shortName: `K1(${spec.mem0})`,
      role: 'COIL',
      color: '#a855f7',
      fill: 'rgba(168, 85, 247, 0.20)'
    });
  }

  // L1 (Output) is always present
  channels.push({
    key: 'L1',
    name: lab && lab.isPlcTerminalLab ? `PL1 (${spec.out0})` : `L1 (${spec.out0})`,
    shortName: lab && lab.isPlcTerminalLab ? `PL1(${spec.out0})` : `L1(${spec.out0})`,
    role: 'OUTPUT',
    color: '#facc15',
    fill: 'rgba(250, 204, 21, 0.20)'
  });

  // L2 (Output)
  if (lab && (lab.showL2 || (lab.outputs && lab.outputs.includes('L2')))) {
    channels.push({
      key: 'L2',
      name: lab && lab.isPlcTerminalLab ? `PL2 (${spec.out1})` : `L2 (${spec.out1})`,
      shortName: lab && lab.isPlcTerminalLab ? `PL2(${spec.out1})` : `L2(${spec.out1})`,
      role: 'OUTPUT',
      color: '#fb923c',
      fill: 'rgba(251, 146, 60, 0.20)'
    });
  }

  return channels;
}

// Records a discrete sample snapshot into timingState
function recordTimingSample(isImmediateChange = false) {
  if (timingState.paused && !isImmediateChange) {
    return;
  }

  const S1 = (typeof state !== 'undefined' && state.switches && state.switches.S1 && state.switches.S1.pressed) ? 1 : 0;
  const S2 = (typeof state !== 'undefined' && state.switches && state.switches.S2 && state.switches.S2.pressed) ? 1 : 0;
  const RELAY = (typeof state !== 'undefined' && state.powerOn && state.simResult && (state.simResult.K1 || state.simResult.K2)) ? 1 : 0;
  const L1 = (typeof state !== 'undefined' && state.powerOn && state.simResult && state.simResult.L1) ? 1 : 0;
  const L2 = (typeof state !== 'undefined' && state.powerOn && state.simResult && state.simResult.L2) ? 1 : 0;

  const t = Math.max(0, getTimingNowSec());

  if (timingState.lastSnap) {
    const prev = timingState.lastSnap;
    const hasChanged = (prev.S1 !== S1 || prev.S2 !== S2 || prev.RELAY !== RELAY || prev.L1 !== L1 || prev.L2 !== L2);

    if (hasChanged) {
      if (prev.S1 !== S1) {
        timingState.transitions.push({
          t,
          label: S1 ? 'S1 ↑' : 'S1 ↓',
          color: '#22c55e'
        });
      }
      if (prev.S2 !== S2) {
        timingState.transitions.push({
          t,
          label: S2 ? 'S2 ↑' : 'S2 ↓',
          color: '#38bdf8'
        });
      }

      // Pre-transition point with previous values ensures crisp 90-degree square edges
      timingState.samples.push({
        t,
        S1: prev.S1,
        S2: prev.S2,
        RELAY: prev.RELAY,
        L1: prev.L1,
        L2: prev.L2
      });
      timingState.samples.push({ t, S1, S2, RELAY, L1, L2 });
    } else {
      // Keep array compact while maintaining sharp corner fidelity
      if (timingState.samples.length >= 2) {
        const last = timingState.samples[timingState.samples.length - 1];
        const secondLast = timingState.samples[timingState.samples.length - 2];
        if (
          (t - last.t) < 0.05 &&
          last.S1 === S1 && last.S2 === S2 && last.RELAY === RELAY && last.L1 === L1 && last.L2 === L2 &&
          secondLast.S1 === S1 && secondLast.S2 === S2 && secondLast.RELAY === RELAY && secondLast.L1 === L1 && secondLast.L2 === L2
        ) {
          last.t = t;
        } else {
          timingState.samples.push({ t, S1, S2, RELAY, L1, L2 });
        }
      } else {
        timingState.samples.push({ t, S1, S2, RELAY, L1, L2 });
      }
    }
  } else {
    // Initial sample
    timingState.samples.push({ t, S1, S2, RELAY, L1, L2 });
  }

  // Prune samples & transitions older than t - 60 seconds
  const cutoff = t - 60;
  if (timingState.samples.length > 0 && timingState.samples[0].t < cutoff) {
    timingState.samples = timingState.samples.filter((s) => s.t >= cutoff);
  }
  if (timingState.transitions.length > 0 && timingState.transitions[0].t < cutoff) {
    timingState.transitions = timingState.transitions.filter((tr) => tr.t >= cutoff);
  }

  timingState.lastSnap = { S1, S2, RELAY, L1, L2 };
}

// Renders the Timing Diagram on HTML5 canvas with High-DPI support
function renderTimingDiagramCanvas() {
  const canvas = document.getElementById('timingDiagramCanvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const width = Math.floor(rect.width) || (canvas.parentElement ? canvas.parentElement.clientWidth : 0) || 800;
  const height = 230;
  const dpr = window.devicePixelRatio || 1;

  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);

  // Background
  ctx.fillStyle = '#090d16';
  ctx.fillRect(0, 0, width, height);

  const channels = getTimingChannelsForCurrentLab();
  const numCh = channels.length || 1;
  const leftPad = 138;
  const rightPad = 16;
  const topPad = 22;
  const botPad = 26;
  const plotX = leftPad;
  const plotW = Math.max(20, width - leftPad - rightPad);
  const plotH = height - topPad - botPad;
  const rowH = plotH / numCh;

  const nowT = Math.max(0, getTimingNowSec());
  const minT = Math.max(0, nowT - timingState.windowSec);
  const maxT = Math.max(timingState.windowSec, nowT);
  const spanT = maxT - minT || 1;

  function tToX(time) {
    return plotX + ((time - minT) / spanT) * plotW;
  }

  // 1. Gridlines and bottom time axis
  ctx.save();
  const stepSec = timingState.windowSec >= 30 ? 5 : (timingState.windowSec >= 20 ? 2 : 1);
  const firstTick = Math.ceil(minT / stepSec) * stepSec;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '10px "JetBrains Mono", monospace';

  for (let s = firstTick; s <= maxT; s += stepSec) {
    const gx = tToX(s);
    if (gx < plotX || gx > plotX + plotW) continue;

    ctx.beginPath();
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.moveTo(gx, topPad);
    ctx.lineTo(gx, topPad + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#64748b';
    ctx.fillText(`${s}s`, gx, topPad + plotH + 7);
  }

  // Bottom axis border
  ctx.beginPath();
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.moveTo(plotX, topPad + plotH);
  ctx.lineTo(plotX + plotW, topPad + plotH);
  ctx.stroke();

  // Axis caption
  ctx.textAlign = 'right';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px Prompt, sans-serif';
  ctx.fillText('แกนเวลา t (วินาที)', plotX + plotW, topPad + plotH + 7);
  ctx.restore();

  // 2. Vertical transition dashed lines across all channels
  timingState.transitions.forEach((tr) => {
    if (tr.t < minT || tr.t > maxT) return;
    const tx = tToX(tr.t);
    if (tx < plotX || tx > plotX + plotW) return;

    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = tr.color || '#38bdf8';
    ctx.lineWidth = 1.3;
    ctx.moveTo(tx, topPad);
    ctx.lineTo(tx, topPad + plotH);
    ctx.stroke();

    // Top transition tag badge
    ctx.setLineDash([]);
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    const tagText = tr.label;
    const tagW = ctx.measureText(tagText).width + 8;
    const tagH = 14;
    const tagY = 3;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(tx - tagW / 2, tagY, tagW, tagH);
    ctx.strokeStyle = tr.color || '#38bdf8';
    ctx.lineWidth = 1;
    ctx.strokeRect(tx - tagW / 2, tagY, tagW, tagH);

    ctx.fillStyle = tr.color || '#38bdf8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tagText, tx, tagY + tagH / 2);
    ctx.restore();
  });

  // 3. Render each channel row
  channels.forEach((ch, idx) => {
    const rowY = topPad + idx * rowH;
    const yHigh = rowY + 8;
    const yLow = rowY + rowH - 8;
    const currVal = (timingState.lastSnap ? timingState.lastSnap[ch.key] : 0) || 0;

    // Row divider
    if (idx > 0) {
      ctx.beginPath();
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.moveTo(0, rowY);
      ctx.lineTo(plotX + plotW, rowY);
      ctx.stroke();
    }

    // Left Header Column
    ctx.save();
    ctx.fillStyle = (idx % 2 === 0) ? '#0c1322' : '#0f172a';
    ctx.fillRect(0, rowY, leftPad, rowH);

    // Accent strip
    ctx.fillStyle = ch.color;
    ctx.fillRect(0, rowY, 4, rowH);

    // Channel name
    ctx.font = 'bold 11px Prompt, sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(ch.name, 10, rowY + 5);

    // Live State Pill
    const pillY = rowY + rowH - 18;
    const isHigh = currVal === 1;
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    const pillText = isHigh ? 'HIGH (1)' : 'LOW (0)';
    const pillW = 54;
    const pillH = 14;

    ctx.fillStyle = isHigh ? ch.fill : '#1e293b';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(10, pillY, pillW, pillH, 3);
      ctx.fill();
    } else {
      ctx.fillRect(10, pillY, pillW, pillH);
    }

    ctx.strokeStyle = isHigh ? ch.color : '#334155';
    ctx.lineWidth = 1;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(10, pillY, pillW, pillH, 3);
      ctx.stroke();
    } else {
      ctx.strokeRect(10, pillY, pillW, pillH);
    }

    ctx.fillStyle = isHigh ? ch.color : '#94a3b8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pillText, 10 + pillW / 2, pillY + pillH / 2);
    ctx.restore();

    // Plot Area for this channel
    // Baseline and high guide lines
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 4]);
    ctx.moveTo(plotX, yHigh);
    ctx.lineTo(plotX + plotW, yHigh);
    ctx.moveTo(plotX, yLow);
    ctx.lineTo(plotX + plotW, yLow);
    ctx.stroke();
    ctx.setLineDash([]);

    // 0 / 1 labels
    ctx.fillStyle = '#475569';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('1', plotX + 4, yHigh);
    ctx.fillText('0', plotX + 4, yLow);
    ctx.restore();

    // Build points array for this channel in [minT, nowT]
    const samples = timingState.samples;
    if (samples.length === 0) return;

    const pts = [];
    let startIdx = 0;
    while (startIdx < samples.length && samples[startIdx].t < minT) {
      startIdx++;
    }
    if (startIdx > 0) {
      const prevS = samples[startIdx - 1];
      pts.push({ t: minT, val: prevS[ch.key] !== undefined ? prevS[ch.key] : 0 });
    } else if (samples.length > 0) {
      pts.push({ t: Math.min(minT, samples[0].t), val: samples[0][ch.key] !== undefined ? samples[0][ch.key] : 0 });
    }

    for (let i = startIdx; i < samples.length; i++) {
      const s = samples[i];
      if (s.t > nowT) break;
      pts.push({ t: s.t, val: s[ch.key] !== undefined ? s[ch.key] : 0 });
    }

    // Extend to nowT
    pts.push({ t: nowT, val: currVal });

    if (pts.length === 0) return;

    // Fill area under HIGH (1)
    ctx.save();
    ctx.beginPath();
    const firstX = Math.max(plotX, tToX(pts[0].t));
    const firstY = pts[0].val === 1 ? yHigh : yLow;
    ctx.moveTo(firstX, yLow);
    ctx.lineTo(firstX, firstY);

    for (let i = 1; i < pts.length; i++) {
      const px = Math.min(plotX + plotW, Math.max(plotX, tToX(pts[i].t)));
      const py = pts[i].val === 1 ? yHigh : yLow;
      const prevPy = pts[i - 1].val === 1 ? yHigh : yLow;
      ctx.lineTo(px, prevPy);
      ctx.lineTo(px, py);
    }
    const lastX = Math.min(plotX + plotW, tToX(nowT));
    ctx.lineTo(lastX, yLow);
    ctx.closePath();
    ctx.fillStyle = ch.fill;
    ctx.fill();
    ctx.restore();

    // Stroke digital square waveform
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = ch.color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'miter';
    ctx.moveTo(firstX, firstY);

    for (let i = 1; i < pts.length; i++) {
      const px = Math.min(plotX + plotW, Math.max(plotX, tToX(pts[i].t)));
      const py = pts[i].val === 1 ? yHigh : yLow;
      const prevPy = pts[i - 1].val === 1 ? yHigh : yLow;
      ctx.lineTo(px, prevPy);
      ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Draw transition dots
    for (let i = 1; i < pts.length; i++) {
      const prevVal = pts[i - 1].val;
      const curV = pts[i].val;
      if (prevVal !== curV) {
        const px = tToX(pts[i].t);
        if (px >= plotX && px <= plotX + plotW) {
          ctx.beginPath();
          ctx.fillStyle = ch.color;
          ctx.arc(px, (yHigh + yLow) / 2, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Glowing head dot at nowT
    const headX = Math.min(plotX + plotW, tToX(nowT));
    const headY = currVal === 1 ? yHigh : yLow;

    ctx.beginPath();
    ctx.fillStyle = ch.fill;
    ctx.arc(headX, headY, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.fillStyle = ch.color;
    ctx.arc(headX, headY, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  });

  // Vertical boundary line between left header and plot area
  ctx.beginPath();
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1.5;
  ctx.moveTo(plotX, 0);
  ctx.lineTo(plotX, topPad + plotH);
  ctx.stroke();

  // 4. Cursor hover readout
  if (timingState.hoverX !== null && timingState.hoverX >= plotX && timingState.hoverX <= plotX + plotW) {
    const hx = timingState.hoverX;
    const hoverT = minT + ((hx - plotX) / plotW) * spanT;

    let matchedSample = null;
    for (let i = timingState.samples.length - 1; i >= 0; i--) {
      if (timingState.samples[i].t <= hoverT) {
        matchedSample = timingState.samples[i];
        break;
      }
    }
    if (!matchedSample && timingState.samples.length > 0) {
      matchedSample = timingState.samples[0];
    }

    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.moveTo(hx, topPad);
    ctx.lineTo(hx, topPad + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    let readout = `t = ${hoverT.toFixed(2)}s`;
    if (matchedSample) {
      channels.forEach((ch) => {
        readout += ` | ${ch.shortName}:${matchedSample[ch.key] !== undefined ? matchedSample[ch.key] : 0}`;
      });
    }

    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    const rw = ctx.measureText(readout).width + 16;
    const rh = 18;
    let rx = hx - rw / 2;
    if (rx < plotX + 4) rx = plotX + 4;
    if (rx + rw > plotX + plotW - 4) rx = plotX + plotW - rw - 4;
    const ry = 2;

    ctx.fillStyle = '#0f172a';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(rx, ry, rw, rh, 4);
      ctx.fill();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = '#38bdf8';
      ctx.strokeRect(rx, ry, rw, rh);
    }

    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(readout, rx + rw / 2, ry + rh / 2);
    ctx.restore();
  }

  // Subtle Kru-Jirawat watermark
  ctx.save();
  ctx.fillStyle = 'rgba(100, 116, 139, 0.22)';
  ctx.font = '700 11px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('Kru-Jirawat.com', width - 12, height - 6);
  ctx.restore();

  ctx.restore();
}

// Timing loop running at ~35 fps
function startTimingDiagramLoop() {
  if (timingState.rafId) return;

  let lastFrameTime = 0;
  function timingLoop(timestamp) {
    timingState.rafId = requestAnimationFrame(timingLoop);
    if (!timingState.paused) {
      if (timestamp - lastFrameTime >= 28) {
        lastFrameTime = timestamp;
        recordTimingSample(false);
        renderTimingDiagramCanvas();
      }
    }
  }
  timingState.rafId = requestAnimationFrame(timingLoop);
}

// Stops truth-table auto-play demonstration
function stopTimingAutoPlay() {
  if (timingState.autoPlayTimer) {
    clearInterval(timingState.autoPlayTimer);
    timingState.autoPlayTimer = null;
  }
  timingState.autoPlayStepIdx = 0;
  const btn = document.getElementById('btnTimingAutoPlay');
  if (btn) {
    btn.classList.remove('playing');
    btn.textContent = '▶️ จำลองอัตโนมัติ';
  }
}

// Toggles automatic demonstration stepping through truth table
function toggleTimingAutoPlay() {
  if (timingState.autoPlayTimer) {
    stopTimingAutoPlay();
    return;
  }

  // Unpause if paused
  if (timingState.paused) {
    timingState.paused = false;
    timingState.totalPausedMs += (performance.now() - timingState.pausedAtMs);
    timingState.pausedAtMs = 0;
    const pauseBtn = document.getElementById('btnTimingPause');
    if (pauseBtn) {
      pauseBtn.classList.remove('paused');
      pauseBtn.setAttribute('aria-pressed', 'false');
      pauseBtn.textContent = '⏸️ หยุดภาพ';
    }
  }

  const lab = LABS[state.currentLabId];
  if (!lab || !lab.truthTable || lab.truthTable.length === 0) return;

  const btn = document.getElementById('btnTimingAutoPlay');
  if (btn) {
    btn.classList.add('playing');
    btn.textContent = '⏹️ หยุดจำลอง';
  }

  timingState.autoPlayStepIdx = 0;
  applyTruthTableRow(timingState.autoPlayStepIdx);

  timingState.autoPlayTimer = setInterval(() => {
    const curLab = LABS[state.currentLabId];
    if (!curLab || !curLab.truthTable || curLab.truthTable.length === 0) {
      stopTimingAutoPlay();
      return;
    }
    timingState.autoPlayStepIdx = (timingState.autoPlayStepIdx + 1) % curLab.truthTable.length;
    applyTruthTableRow(timingState.autoPlayStepIdx);
  }, 1800);
}

// Resets timing diagram records and restarts time axis
function resetTimingDiagram() {
  stopTimingAutoPlay();
  timingState.samples = [];
  timingState.transitions = [];
  timingState.startEpochMs = performance.now();
  timingState.pausedAtMs = 0;
  timingState.totalPausedMs = 0;
  timingState.lastSnap = null;
  recordTimingSample(true);
  renderTimingDiagramCanvas();
}

// Initializes Timing Diagram controls & events
function initTimingDiagram() {
  const pauseBtn = document.getElementById('btnTimingPause');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      timingState.paused = !timingState.paused;
      if (timingState.paused) {
        timingState.pausedAtMs = performance.now();
        pauseBtn.classList.add('paused');
        pauseBtn.setAttribute('aria-pressed', 'true');
        pauseBtn.textContent = '▶️ เล่นต่อ';
      } else {
        timingState.totalPausedMs += (performance.now() - timingState.pausedAtMs);
        timingState.pausedAtMs = 0;
        pauseBtn.classList.remove('paused');
        pauseBtn.setAttribute('aria-pressed', 'false');
        pauseBtn.textContent = '⏸️ หยุดภาพ';
      }
      renderTimingDiagramCanvas();
    });
  }

  const windowBtn = document.getElementById('btnTimingWindow');
  if (windowBtn) {
    windowBtn.addEventListener('click', () => {
      if (timingState.windowSec === 10) {
        timingState.windowSec = 15;
      } else if (timingState.windowSec === 15) {
        timingState.windowSec = 30;
      } else {
        timingState.windowSec = 10;
      }
      windowBtn.textContent = `⏱️ ช่วงเวลา: ${timingState.windowSec}s`;
      renderTimingDiagramCanvas();
    });
  }

  const clearBtn = document.getElementById('btnTimingClear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      resetTimingDiagram();
    });
  }

  const autoBtn = document.getElementById('btnTimingAutoPlay');
  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      toggleTimingAutoPlay();
    });
  }

  const canvas = document.getElementById('timingDiagramCanvas');
  if (canvas) {
    const updateHover = (e) => {
      const rect = canvas.getBoundingClientRect();
      timingState.hoverX = e.clientX - rect.left;
      timingState.hoverY = e.clientY - rect.top;
      renderTimingDiagramCanvas();
    };
    canvas.addEventListener('pointermove', updateHover);
    canvas.addEventListener('pointerenter', updateHover);
    canvas.addEventListener('pointerleave', () => {
      timingState.hoverX = null;
      timingState.hoverY = null;
      renderTimingDiagramCanvas();
    });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) {
        const rect = canvas.getBoundingClientRect();
        timingState.hoverX = e.touches[0].clientX - rect.left;
        timingState.hoverY = e.touches[0].clientY - rect.top;
        renderTimingDiagramCanvas();
      }
    }, { passive: true });
    canvas.addEventListener('touchend', () => {
      timingState.hoverX = null;
      timingState.hoverY = null;
      renderTimingDiagramCanvas();
    });
  }

  window.addEventListener('resize', () => {
    renderTimingDiagramCanvas();
  });

  startTimingDiagramLoop();
}

// Load Selected Lab Configuration
function loadLab(labId) {
  const lab = LABS[labId];
  if (!lab) return;

  // Stop auto play if running and cleanly reset timing diagram
  stopTimingAutoPlay();
  if (typeof timingState !== 'undefined') {
    timingState.samples = [];
    timingState.transitions = [];
    timingState.startEpochMs = performance.now();
    timingState.pausedAtMs = 0;
    timingState.totalPausedMs = 0;
    timingState.lastSnap = null;
  }

  state.currentLabId = labId;
  const labSelect = document.getElementById('labSelect');
  if (labSelect && labSelect.value !== labId) {
    labSelect.value = labId;
  }
  state.showingHints = false;
  state.selectedTerminal = null;
  state.activeWaypoints = [];
  state.liveTestedRows = {};
  state.lastVerificationResults = null;
  state.fuseBlown = { F1: false, F2: false, MAIN: false };
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

  if (lamp2Group) lamp2Group.style.opacity = lab.showL2 ? '1' : '0.25';
  if (switch2Group) switch2Group.style.opacity = lab.showS2 ? '1' : '0.35';
  if (relaysGroup) relaysGroup.style.opacity = lab.showRelays ? '1' : '0.35';

  // Toggle between Relay Workbench Board and PLC Terminal Block Board
  const isPlcLab = Boolean(lab && lab.isPlcTerminalLab);
  state.isPlcBoardActive = isPlcLab;

  const mainBoard = document.getElementById('mainBoard');
  const powerModule = document.getElementById('powerModule');
  const plcTerminalBoard = document.getElementById('plcTerminalBoard');
  const wbBoardBadge = document.getElementById('workbenchBoardBadge');
  const pwrSupplyLabel = document.getElementById('powerSupplyLabel');
  const wbPlcModelSelect = document.getElementById('wbPlcModelSelect');

  if (isPlcLab) {
    if (mainBoard) mainBoard.style.display = 'none';
    if (powerModule) powerModule.style.display = 'none';
    if (plcTerminalBoard) plcTerminalBoard.style.display = '';
    if (wbBoardBadge) wbBoardBadge.textContent = 'ชุดทดลองการเชื่อมต่ออินพุต-เอาต์พุต PLC ผ่าน TERMINAL กลาง';
    if (pwrSupplyLabel) pwrSupplyLabel.textContent = 'แหล่งจ่ายไฟ 24VDC:';
    if (wbPlcModelSelect) wbPlcModelSelect.style.display = '';

    const outSection = document.getElementById('plcOutputSectionGroup');
    if (outSection) {
      outSection.style.opacity = '1';
    }
    const fuse2Grp = document.getElementById('plcFuse2Group');
    const lamp1Grp = document.getElementById('plcLamp1Group');
    const lamp2Grp = document.getElementById('plcLamp2Group');
    const monGrp = document.getElementById('plcPanelLedMonitorGroup');
    if (lab.plcInputOnlyLab) {
      if (fuse2Grp) fuse2Grp.style.display = 'none';
      if (lamp1Grp) lamp1Grp.style.display = 'none';
      if (lamp2Grp) lamp2Grp.style.display = 'none';
      if (monGrp) monGrp.style.display = '';
    } else {
      if (fuse2Grp) fuse2Grp.style.display = '';
      if (lamp1Grp) lamp1Grp.style.display = '';
      if (lamp2Grp) lamp2Grp.style.display = '';
      if (monGrp) monGrp.style.display = 'none';
    }
  } else {
    if (mainBoard) mainBoard.style.display = '';
    if (powerModule) powerModule.style.display = '';
    if (plcTerminalBoard) plcTerminalBoard.style.display = 'none';
    if (wbBoardBadge) wbBoardBadge.textContent = 'ชุดทดลองการเชื่อมต่อวงจรไฟฟ้าควบคุมด้วย RELAY';
    if (pwrSupplyLabel) pwrSupplyLabel.textContent = 'แหล่งจ่ายไฟ 12VDC:';
    if (wbPlcModelSelect) wbPlcModelSelect.style.display = 'none';
  }

  const wbPlcLogicSelect = document.getElementById('wbPlcLogicSelect');
  if (wbPlcLogicSelect) {
    wbPlcLogicSelect.style.display = isPlcLab ? '' : 'none';
    wbPlcLogicSelect.value = state.plcWiringLogic || 'negative';
  }

  updatePlcModelUI(state.plcModel);
  updatePlcLogicModeUI();

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

  if (typeof plcState !== 'undefined') {
    plcState.idealMemoryM0 = false;
  }

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

    // Click on blown fuse overlay or short circuit alert -> reset fuses
    if (e.target.closest('#plcFuse1BlownGroup, #plcFuse2BlownGroup, #shortCircuitAlert')) {
      e.preventDefault();
      e.stopPropagation();
      resetFuses();
      return;
    }

    // Direct click/touch on PLC Pushbutton switch on PLC Terminal Board
    const plcSwHit = e.target.closest('[data-plc-sw]');
    if (plcSwHit) {
      e.preventDefault();
      e.stopPropagation();
      const sw = plcSwHit.getAttribute('data-plc-sw');
      if (sw && state.switches && state.switches[sw]) {
        if (state.switches[sw].locked) {
          state.switches[sw].pressed = !state.switches[sw].pressed;
        } else {
          state.switches[sw].pressed = true;
        }
        updateSimulationUI();
      }
      return;
    }

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
      const hints = getActiveHintWires(lab);
      state.wires = hints.map((hw, i) => ({
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

// ============================================================================
// Custom Lab Builder & Manager (Password Gate: 'tatc')
// ============================================================================

const TEACHER_PASSWORD = 'tatc';
const CUSTOM_LABS_STORAGE_KEY = 'tatc_custom_labs_v1';
const DELETED_LABS_STORAGE_KEY = 'tatc_deleted_custom_labs_v1';

// Multi-Tier Cloud Sync Configuration (Dual-Blob + Dual-Pointer)
const CLOUD_POINTER_GET_URL = 'https://keyvalue.immanuel.co/api/KeyVal/GetValue/rxkvtq0k/tatc_cloud_id';
const CLOUD_POINTER_SET_URL = 'https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/rxkvtq0k/tatc_cloud_id';
const CLOUD_RESTFUL_PTR_URL = 'https://api.restful-api.dev/objects/ff808181a09d98f701a153af69fa1795';
const BYTEBIN_POST_URL = 'https://bytebin.lucko.me/post';
const BYTEBIN_GET_BASE = 'https://bytebin.lucko.me';
const DPASTE_POST_URL = 'https://dpaste.com/api/v2/';
const DPASTE_GET_BASE = 'https://dpaste.com';
const STATIC_CUSTOM_LABS_URL = './custom_labs.json';

let isCloudSyncing = false;
let lastCloudError = '';

function timeoutSignal(ms) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

function formatError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  return err.message || String(err);
}

async function withRetry(fn, retries = 1, delayMs = 300) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

function getDeletedCustomLabIds() {
  try {
    const raw = localStorage.getItem(DELETED_LABS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('Failed to load deleted lab IDs:', e);
    return [];
  }
}

function saveDeletedCustomLabIds(ids) {
  try {
    const unique = Array.from(new Set(ids || []));
    localStorage.setItem(DELETED_LABS_STORAGE_KEY, JSON.stringify(unique));
  } catch (e) {
    console.warn('Failed to save deleted lab IDs:', e);
  }
}

function recordDeletedCustomLabId(labId) {
  if (!labId) return;
  const current = getDeletedCustomLabIds();
  if (!current.includes(labId)) {
    current.push(labId);
    saveDeletedCustomLabIds(current);
  }
}

function removeDeletedCustomLabId(labId) {
  if (!labId) return;
  const current = getDeletedCustomLabIds();
  const next = current.filter((id) => id !== labId);
  saveDeletedCustomLabIds(next);
}

function setCloudSyncBadge(stateType, text, title) {
  const badges = document.querySelectorAll('.cloud-sync-badge');
  badges.forEach((badge) => {
    badge.classList.remove('synced', 'syncing', 'error');
    if (stateType) badge.classList.add(stateType);
    if (text) badge.textContent = text;
    if (title !== undefined) {
      badge.title = title;
    } else if (stateType === 'synced') {
      badge.title = text || 'ซิงค์สำเร็จ';
    } else if (stateType === 'syncing') {
      badge.title = text || 'กำลังซิงค์ข้อมูล...';
    }
  });
}

const builderState = {
  editingLabId: null,
  title: '',
  objective: '',
  logicComparison: '',
  branches: [
    { topSlot: 'S1_NO', midSlot: 'S2_NO', loadSlot: 'L1' },
    { topSlot: null, midSlot: null, loadSlot: null },
    { topSlot: null, midSlot: null, loadSlot: null }
  ],
  bridge12: false,
  bridge23: false,
  selectedPaletteComp: null,
  selectedPaletteLoad: null,
  capturedWires: null,
  truthTable: []
};

function getStoredCustomLabs() {
  try {
    const raw = localStorage.getItem(CUSTOM_LABS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('Failed to load custom labs from storage:', e);
    return {};
  }
}

function saveStoredCustomLabs(customLabs) {
  try {
    localStorage.setItem(CUSTOM_LABS_STORAGE_KEY, JSON.stringify(customLabs));
  } catch (e) {
    console.warn('Failed to save custom labs to storage:', e);
  }
}

async function fetchLatestCloudPointer() {
  // Query KeyValue and Restful pointer IN PARALLEL
  const [kvResult, rfResult] = await Promise.allSettled([
    (async () => {
      const kvRes = await fetch(`${CLOUD_POINTER_GET_URL}?t=${Date.now()}`, {
        cache: 'no-store',
        signal: timeoutSignal(15000)
      });
      if (!kvRes.ok) throw new Error(`HTTP ${kvRes.status}`);
      let text = await kvRes.text();
      text = (text || '').replace(/["'\s]/g, '').trim();
      if (text && text.includes('_')) {
        return text;
      }
      throw new Error('invalid format');
    })(),
    (async () => {
      const rfRes = await fetch(`${CLOUD_RESTFUL_PTR_URL}?t=${Date.now()}`, {
        cache: 'no-store',
        signal: timeoutSignal(15000)
      });
      if (!rfRes.ok) throw new Error(`HTTP ${rfRes.status}`);
      const obj = await rfRes.json();
      if (obj && obj.data) {
        if (obj.data.ptr && typeof obj.data.ptr === 'string' && obj.data.ptr.includes('_')) {
          return obj.data.ptr.trim();
        } else if (obj.data.dpasteId || obj.data.bytebinKey) {
          return `${obj.data.dpasteId || 'none'}_${obj.data.bytebinKey || 'none'}`;
        }
      }
      throw new Error('invalid format');
    })()
  ]);

  let kvPtr = kvResult.status === 'fulfilled' ? kvResult.value : null;
  let rfPtr = rfResult.status === 'fulfilled' ? rfResult.value : null;

  const ptrErrors = [];
  if (kvResult.status === 'rejected') {
    console.warn('KV pointer fetch warning:', kvResult.reason);
    ptrErrors.push(`kv: ${formatError(kvResult.reason)}`);
  }
  if (rfResult.status === 'rejected') {
    console.warn('Restful pointer fetch warning:', rfResult.reason);
    ptrErrors.push(`restful: ${formatError(rfResult.reason)}`);
  }

  // Prefer KeyValue's combined pointer if valid, else Restful's
  const combinedPtr = kvPtr || rfPtr || '';

  if (!combinedPtr && ptrErrors.length > 0) {
    lastCloudError = ptrErrors.join('; ');
  }

  if (combinedPtr && combinedPtr.includes('_')) {
    const parts = combinedPtr.split('_');
    return {
      dpasteId: parts[0] && parts[0] !== 'none' ? parts[0] : '',
      bytebinKey: parts[1] && parts[1] !== 'none' ? parts[1] : ''
    };
  }

  return { dpasteId: '', bytebinKey: '' };
}

async function fetchCloudBlobByPointer(ptr) {
  if (!ptr) return null;
  const { dpasteId, bytebinKey } = ptr;
  if ((!bytebinKey || bytebinKey === 'none') && (!dpasteId || dpasteId === 'none')) {
    return null;
  }

  const blobErrors = [];

  // 1. Try Bytebin first
  if (bytebinKey && bytebinKey !== 'none') {
    try {
      const res = await fetch(`${BYTEBIN_GET_BASE}/${bytebinKey}`, {
        cache: 'no-store',
        signal: timeoutSignal(20000)
      });
      if (res.ok) {
        const data = await res.json();
        if (data) {
          return data.customLabs ? data : (data.data || null);
        }
      } else {
        blobErrors.push(`bytebin: HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn('Bytebin fetch blob warning:', err);
      blobErrors.push(`bytebin: ${formatError(err)}`);
    }
  }

  // 2. Try dpaste second
  if (dpasteId && dpasteId !== 'none') {
    try {
      const res = await fetch(`${DPASTE_GET_BASE}/${dpasteId}.txt`, {
        cache: 'no-store',
        signal: timeoutSignal(20000)
      });
      if (res.ok) {
        const text = await res.text();
        const data = JSON.parse(text);
        if (data) {
          return data.customLabs ? data : (data.data || null);
        }
      } else {
        blobErrors.push(`dpaste: HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn('dpaste fetch blob warning:', err);
      blobErrors.push(`dpaste: ${formatError(err)}`);
    }
  }

  if (blobErrors.length > 0) {
    lastCloudError = (lastCloudError ? `${lastCloudError}; ` : '') + blobErrors.join('; ');
  }

  return null;
}

async function uploadCloudBlobAndPointer(payloadObj) {
  const jsonStr = JSON.stringify(payloadObj);

  let bytebinKey = 'none';
  let dpasteId = 'none';
  const uploadErrors = [];

  // Upload to bytebin and dpaste IN PARALLEL (helpers never throw)
  const [bbRes, dpRes] = await Promise.all([
    (async () => {
      try {
        const key = await withRetry(async () => {
          const res = await fetch(BYTEBIN_POST_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: jsonStr,
            signal: timeoutSignal(25000)
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (data && data.key) return data.key;
          throw new Error('missing key');
        }, 1);
        return { ok: true, key };
      } catch (e) {
        console.warn('Bytebin upload warning:', e);
        return { ok: false, error: formatError(e) };
      }
    })(),
    (async () => {
      try {
        const id = await withRetry(async () => {
          const formBody = new URLSearchParams();
          formBody.append('content', jsonStr);
          formBody.append('syntax', 'json');
          formBody.append('expiry_days', '365');
          const res = await fetch(DPASTE_POST_URL, {
            method: 'POST',
            body: formBody,
            signal: timeoutSignal(25000)
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const dpText = (await res.text()).trim();
          const parts = dpText.replace(/\/+$/, '').split('/');
          const extracted = parts[parts.length - 1].trim();
          if (extracted && extracted.length >= 4 && extracted.length <= 20) {
            return extracted;
          }
          throw new Error('invalid id format');
        }, 1);
        return { ok: true, id };
      } catch (e) {
        console.warn('dpaste upload warning:', e);
        return { ok: false, error: formatError(e) };
      }
    })()
  ]);

  if (bbRes.ok) {
    bytebinKey = bbRes.key;
  } else {
    uploadErrors.push(`bytebin: ${bbRes.error}`);
  }

  if (dpRes.ok) {
    dpasteId = dpRes.id;
  } else {
    uploadErrors.push(`dpaste: ${dpRes.error}`);
  }

  if (bytebinKey === 'none' && dpasteId === 'none') {
    lastCloudError = uploadErrors.length > 0 ? uploadErrors.join('; ') : 'upload failed';
    return { success: false };
  }

  const combinedPtr = `${dpasteId}_${bytebinKey}`;
  const pointerErrors = [];

  // Save pointers to KeyValue and Restful IN PARALLEL (helpers never throw)
  const [kvRes, rfRes] = await Promise.all([
    (async () => {
      try {
        await withRetry(async () => {
          const res = await fetch(`${CLOUD_POINTER_SET_URL}/${combinedPtr}`, {
            method: 'POST',
            signal: timeoutSignal(15000)
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }, 1);
        return { ok: true };
      } catch (e) {
        console.warn('KV pointer update warning:', e);
        return { ok: false, error: formatError(e) };
      }
    })(),
    (async () => {
      try {
        await withRetry(async () => {
          const res = await fetch(CLOUD_RESTFUL_PTR_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'tatc_ptr',
              data: { ptr: combinedPtr, dpasteId, bytebinKey }
            }),
            signal: timeoutSignal(15000)
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }, 1);
        return { ok: true };
      } catch (e) {
        console.warn('Restful pointer update warning:', e);
        return { ok: false, error: formatError(e) };
      }
    })()
  ]);

  const kvSaved = kvRes.ok;
  const rfSaved = rfRes.ok;

  if (!kvRes.ok) pointerErrors.push(`kv: ${kvRes.error}`);
  if (!rfRes.ok) pointerErrors.push(`restful: ${rfRes.error}`);

  const ptrSaved = kvSaved || rfSaved;

  if (!ptrSaved) {
    const allErrors = [...uploadErrors, ...pointerErrors];
    lastCloudError = allErrors.length > 0 ? allErrors.join('; ') : 'pointer save failed';
    return { success: false, combinedPtr };
  }

  lastCloudError = '';
  return { success: true, combinedPtr };
}

async function fetchCustomLabsFromServer(silent = true, allowPushBack = true) {
  if (isCloudSyncing) return { success: false, inProgress: true };

  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (isOffline) {
    lastCloudError = 'ออฟไลน์ (ไม่ได้เชื่อมต่อเครือข่ายอินเทอร์เน็ต)';
    setCloudSyncBadge('error', '⚠️ ออฟไลน์', lastCloudError);
    if (!silent) {
      alert(`อุปกรณ์ของคุณออฟไลน์อยู่ในขณะนี้ ระบบจะใช้ข้อมูลที่บันทึกไว้ในเครื่องของคุณ\n\nรายละเอียด: ${lastCloudError}`);
    }
    return { success: false, offline: true };
  }

  isCloudSyncing = true;
  setCloudSyncBadge('syncing', '⏳ กำลังซิงค์ข้อมูลกับเซิร์ฟเวอร์...');

  let fetchedData = null;
  let remoteServerReachable = false;

  // 1. Fetch pointer & blob from cloud
  try {
    const ptr = await fetchLatestCloudPointer();
    fetchedData = await fetchCloudBlobByPointer(ptr);
    if (fetchedData) {
      remoteServerReachable = true;
    }
  } catch (err) {
    console.warn('Cloud sync lookup error:', err);
    if (!lastCloudError) lastCloudError = formatError(err);
  }

  // 2. Fallback to static custom_labs.json if remote failed
  if (!fetchedData) {
    try {
      const staticRes = await fetch(`${STATIC_CUSTOM_LABS_URL}?t=${Date.now()}`, {
        cache: 'no-store',
        signal: timeoutSignal(10000)
      });
      if (staticRes.ok) {
        fetchedData = await staticRes.json();
      }
    } catch (err) {
      console.warn('Static custom_labs.json fetch error:', err);
    }
  }

  // 3. Merge incoming data with local storage & memory
  if (fetchedData && typeof fetchedData === 'object') {
    const incomingLabs = fetchedData.customLabs || {};
    const incomingDeleted = Array.isArray(fetchedData.deletedIds) ? fetchedData.deletedIds : [];

    const localDeleted = getDeletedCustomLabIds();
    const mergedDeleted = Array.from(new Set([...localDeleted, ...incomingDeleted]));
    saveDeletedCustomLabIds(mergedDeleted);

    const localLabs = getStoredCustomLabs();
    let needsPushToServer = false;

    // Detect if local storage has any unsynced changes that the remote server does NOT have
    Object.keys(localLabs).forEach((id) => {
      if (!mergedDeleted.includes(id)) {
        if (!incomingLabs[id] || (localLabs[id].updatedAt || 0) > (incomingLabs[id].updatedAt || 0)) {
          needsPushToServer = true;
          localLabs[id].updatedAt = localLabs[id].updatedAt || Date.now();
        }
      }
    });

    if (localDeleted.some((dId) => !incomingDeleted.includes(dId))) {
      needsPushToServer = true;
    }

    // Remove any labs marked as deleted
    mergedDeleted.forEach((dId) => {
      delete localLabs[dId];
      delete LABS[dId];
    });

    let currentLabUpdated = false;

    // Merge incoming labs
    Object.keys(incomingLabs).forEach((id) => {
      if (mergedDeleted.includes(id)) return;
      const incomingLab = incomingLabs[id];
      const existingLab = localLabs[id];

      if (!existingLab) {
        localLabs[id] = incomingLab;
        LABS[id] = incomingLab;
        if (state.currentLabId === id) currentLabUpdated = true;
      } else {
        const incomingTime = incomingLab.updatedAt || 0;
        const existingTime = existingLab.updatedAt || 0;
        if (incomingTime >= existingTime) {
          localLabs[id] = incomingLab;
          LABS[id] = incomingLab;
          if (state.currentLabId === id) currentLabUpdated = true;
        }
      }
    });

    saveStoredCustomLabs(localLabs);
    refreshCustomLabsInSelect();
    renderBuilderCustomLabsList();

    if (currentLabUpdated && state.currentLabId && LABS[state.currentLabId]) {
      const cur = LABS[state.currentLabId];
      const tEl = document.getElementById('labTitle');
      if (tEl) tEl.textContent = cur.title;
      const oEl = document.getElementById('labObjective');
      if (oEl) oEl.textContent = cur.objective || '';
      renderSchematic();
      renderTruthTable();
    }

    let labCount = Object.keys(localLabs).length;
    setCloudSyncBadge('synced', `☁️ ซิงค์กับเซิร์ฟเวอร์แล้ว (${labCount} โจทย์)`);
    isCloudSyncing = false;

    if (allowPushBack && (needsPushToServer || (!remoteServerReachable && labCount > 0))) {
      const pushRes = await pushCustomLabsToServer();
      if (pushRes && pushRes.success) {
        labCount = Object.keys(getStoredCustomLabs()).length;
        setCloudSyncBadge('synced', `☁️ ซิงค์ข้อมูลออนไลน์แล้ว (${labCount} โจทย์)`);
      }
    }

    if (!silent) {
      alert(`ซิงค์ข้อมูลกับเซิร์ฟเวอร์เรียบร้อยแล้ว (มีโจทย์ทั้งหมด ${labCount} ใบงาน)`);
    }
    return { success: true, count: labCount };
  } else {
    isCloudSyncing = false;
    const localLabs = getStoredCustomLabs();
    let labCount = Object.keys(localLabs).length;

    if (allowPushBack && labCount > 0) {
      const pushRes = await pushCustomLabsToServer();
      if (pushRes && pushRes.success) {
        labCount = Object.keys(getStoredCustomLabs()).length;
        setCloudSyncBadge('synced', `☁️ ซิงค์ข้อมูลออนไลน์แล้ว (${labCount} โจทย์)`);
        if (!silent) {
          alert(`ซิงค์ข้อมูลกับเซิร์ฟเวอร์เรียบร้อยแล้ว (มีโจทย์ทั้งหมด ${labCount} ใบงาน)`);
        }
        return { success: true, count: labCount };
      }
    }

    const checkOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (checkOffline) {
      lastCloudError = 'ออฟไลน์ (ไม่ได้เชื่อมต่อเครือข่ายอินเทอร์เน็ต)';
    }
    const badgeText = checkOffline ? '⚠️ ออฟไลน์' : '⚠️ ซิงค์ไม่สำเร็จ';
    const errDetail = lastCloudError || (checkOffline ? 'ออฟไลน์' : 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์');
    setCloudSyncBadge('error', badgeText, errDetail);
    if (!silent) {
      const baseMsg = checkOffline
        ? 'อุปกรณ์ของคุณออฟไลน์อยู่ในขณะนี้ ระบบจะใช้ข้อมูลที่บันทึกไว้ในเครื่องของคุณ'
        : 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ออนไลน์ได้ในขณะนี้ ระบบจะใช้ข้อมูลที่บันทึกไว้ในเครื่องของคุณ';
      alert(`${baseMsg}\n\nรายละเอียด: ${errDetail}`);
    }
    return { success: false };
  }
}

async function pushCustomLabsToServer() {
  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (isOffline) {
    lastCloudError = 'ออฟไลน์ (ไม่ได้เชื่อมต่อเครือข่ายอินเทอร์เน็ต)';
    setCloudSyncBadge('error', '⚠️ ออฟไลน์', lastCloudError);
    return { success: false, error: new Error('Offline') };
  }

  setCloudSyncBadge('syncing', '⏳ กำลังอัปโหลดไปยังเซิร์ฟเวอร์...');

  // 1. Try to fetch latest pointer and remote blob to merge changes before pushing
  let remoteLabs = {};
  let remoteDeleted = [];
  try {
    const ptr = await fetchLatestCloudPointer();
    const remoteData = await fetchCloudBlobByPointer(ptr);
    if (remoteData && typeof remoteData === 'object') {
      remoteLabs = remoteData.customLabs || {};
      remoteDeleted = Array.isArray(remoteData.deletedIds) ? remoteData.deletedIds : [];
    }
  } catch (err) {
    console.warn('Pre-push remote fetch warning:', err);
  }

  // Merge remote customLabs and deletedIds with local
  const localDeleted = getDeletedCustomLabIds();
  const mergedDeleted = Array.from(new Set([...localDeleted, ...remoteDeleted]));
  saveDeletedCustomLabIds(mergedDeleted);

  const localLabs = getStoredCustomLabs();

  // Remove deleted labs
  mergedDeleted.forEach((dId) => {
    delete localLabs[dId];
    delete LABS[dId];
  });

  // Merge remote labs
  Object.keys(remoteLabs).forEach((id) => {
    if (mergedDeleted.includes(id)) return;
    const rLab = remoteLabs[id];
    const lLab = localLabs[id];
    if (!lLab) {
      localLabs[id] = rLab;
      LABS[id] = rLab;
    } else {
      const rTime = rLab.updatedAt || 0;
      const lTime = lLab.updatedAt || 0;
      if (rTime > lTime) {
        localLabs[id] = rLab;
        LABS[id] = rLab;
      }
    }
  });

  // Ensure updatedAt is set on all local labs
  Object.keys(localLabs).forEach((id) => {
    if (!localLabs[id].updatedAt) {
      localLabs[id].updatedAt = Date.now();
    }
    LABS[id] = localLabs[id];
  });

  saveStoredCustomLabs(localLabs);
  refreshCustomLabsInSelect();
  renderBuilderCustomLabsList();

  try {
    const upRes = await uploadCloudBlobAndPointer({
      customLabs: localLabs,
      deletedIds: mergedDeleted,
      updatedAt: Date.now()
    });

    if (upRes && upRes.success) {
      const count = Object.keys(localLabs).length;
      setCloudSyncBadge('synced', `☁️ ซิงค์ออนไลน์แล้ว (${count} โจทย์)`);
      return { success: true };
    }

    const checkOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (checkOffline) {
      lastCloudError = 'ออฟไลน์ (ไม่ได้เชื่อมต่อเครือข่ายอินเทอร์เน็ต)';
    }
    const badgeText = checkOffline ? '⚠️ ออฟไลน์' : '⚠️ ซิงค์ไม่สำเร็จ';
    const errDetail = lastCloudError || (checkOffline ? 'ออฟไลน์' : 'อัปโหลดเซิร์ฟเวอร์ไม่สำเร็จ');
    setCloudSyncBadge('error', badgeText, errDetail);
    return { success: false };
  } catch (err) {
    console.warn('pushCustomLabsToServer error:', err);
    if (!lastCloudError) lastCloudError = formatError(err);
    const checkOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (checkOffline) {
      lastCloudError = 'ออฟไลน์ (ไม่ได้เชื่อมต่อเครือข่ายอินเทอร์เน็ต)';
    }
    const badgeText = checkOffline ? '⚠️ ออฟไลน์' : '⚠️ ซิงค์ไม่สำเร็จ';
    setCloudSyncBadge('error', badgeText, lastCloudError);
    return { success: false, error: err };
  }
}

function exportCustomLabsJson() {
  const customLabs = getStoredCustomLabs();
  const deletedIds = getDeletedCustomLabIds();
  const exportData = {
    version: 'tatc_v1',
    exportedAt: new Date().toISOString(),
    updatedAt: Date.now(),
    deletedIds: deletedIds,
    customLabs: customLabs
  };

  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exportData, null, 2));
  const dlAnchor = document.createElement('a');
  dlAnchor.setAttribute('href', dataStr);
  dlAnchor.setAttribute('download', `tatc_custom_labs_${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(dlAnchor);
  dlAnchor.click();
  dlAnchor.remove();
}

function handleImportCustomLabsFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const content = JSON.parse(e.target.result);
      let incomingLabs = {};
      let incomingDeleted = [];

      if (content && typeof content === 'object') {
        if (content.customLabs && typeof content.customLabs === 'object') {
          incomingLabs = content.customLabs;
          incomingDeleted = Array.isArray(content.deletedIds) ? content.deletedIds : [];
        } else {
          incomingLabs = content;
        }
      }

      const keys = Object.keys(incomingLabs);
      if (keys.length === 0) {
        alert('ไม่พบข้อมูลโจทย์ใบงานในไฟล์ที่เลือก');
        return;
      }

      const localDeleted = getDeletedCustomLabIds();
      const mergedDeleted = Array.from(new Set([...localDeleted, ...incomingDeleted]));
      saveDeletedCustomLabIds(mergedDeleted);

      const localLabs = getStoredCustomLabs();
      let importedCount = 0;

      keys.forEach((id) => {
        const lab = incomingLabs[id];
        if (lab && lab.title) {
          lab.updatedAt = lab.updatedAt || Date.now();
          localLabs[id] = lab;
          LABS[id] = lab;
          removeDeletedCustomLabId(id);
          importedCount++;
        }
      });

      saveStoredCustomLabs(localLabs);
      refreshCustomLabsInSelect();
      renderBuilderCustomLabsList();

      alert(`นำเข้าโจทย์สำเร็จจำนวน ${importedCount} ใบงาน\nระบบกำลังซิงค์ขึ้นเซิร์ฟเวอร์ออนไลน์...`);
      await pushCustomLabsToServer();
    } catch (err) {
      console.error('Import error:', err);
      alert('เกิดข้อผิดพลาดในการอ่านไฟล์ JSON: ไฟล์อาจเสียหายหรือไม่ถูกต้อง');
    }
  };
  reader.readAsText(file);
}

function loadStoredCustomLabsIntoApp() {
  const stored = getStoredCustomLabs();
  Object.keys(stored).forEach((id) => {
    LABS[id] = stored[id];
  });
  refreshCustomLabsInSelect();

  // Background sync with cloud server
  fetchCustomLabsFromServer(true);
}

function refreshCustomLabsInSelect(selectedId = null) {
  const select = document.getElementById('labSelect');
  if (!select) return;

  let optGroup = document.getElementById('customLabsOptGroup');
  const stored = getStoredCustomLabs();
  const keys = Object.keys(stored);

  if (keys.length === 0) {
    if (optGroup) optGroup.remove();
    return;
  }

  if (!optGroup) {
    optGroup = document.createElement('optgroup');
    optGroup.id = 'customLabsOptGroup';
    optGroup.label = '⭐ โจทย์ใบงานเพิ่มเติม (สร้างเอง)';
    select.appendChild(optGroup);
  }

  optGroup.innerHTML = '';
  keys.forEach((id) => {
    const lab = stored[id];
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `★ ${lab.title}`;
    optGroup.appendChild(opt);
  });

  if (selectedId) {
    select.value = selectedId;
  }
}

function simulateCustomSchematic(schematic, s1, s2, prevRelay = false) {
  const branches = (schematic && schematic.branches) ? schematic.branches : [];
  let relayActive = Boolean(prevRelay);

  const isClosed = (comp, rActive) => {
    if (!comp) return false;
    if (comp === 'WIRE_V') return true;
    if (comp === 'S1_NO') return s1 === 1;
    if (comp === 'S1_NC') return s1 === 0;
    if (comp === 'S2_NO') return s2 === 1;
    if (comp === 'S2_NC') return s2 === 0;
    if (comp === 'K1_NO') return rActive === true;
    if (comp === 'K1_NC') return rActive === false;
    return false;
  };

  let l1 = 0, l2 = 0;

  for (let iter = 0; iter < 3; iter++) {
    const topOut = [false, false, false];
    for (let b = 0; b < 3; b++) {
      const bObj = branches[b] || {};
      topOut[b] = isClosed(bObj.topSlot, relayActive);
    }

    if (schematic.bridge12) {
      const m12 = topOut[0] || topOut[1];
      topOut[0] = m12;
      topOut[1] = m12;
    }
    if (schematic.bridge23) {
      const m23 = topOut[1] || topOut[2];
      topOut[1] = m23;
      topOut[2] = m23;
    }
    if (schematic.bridge12) {
      const m12 = topOut[0] || topOut[1];
      topOut[0] = m12;
      topOut[1] = m12;
    }

    const midOut = [false, false, false];
    for (let b = 0; b < 3; b++) {
      const bObj = branches[b] || {};
      midOut[b] = topOut[b] && isClosed(bObj.midSlot, relayActive);
    }

    l1 = 0;
    l2 = 0;
    let coilActive = false;
    for (let b = 0; b < 3; b++) {
      const bObj = branches[b] || {};
      if (midOut[b]) {
        if (bObj.loadSlot === 'L1') l1 = 1;
        if (bObj.loadSlot === 'L2') l2 = 1;
        if (bObj.loadSlot === 'K1_COIL') coilActive = true;
      }
    }
    relayActive = coilActive;
  }

  return {
    L1: l1,
    L2: l2,
    RELAY: relayActive ? 1 : 0
  };
}

function generateTruthTableForCustomSchematic(schematic) {
  const branches = schematic.branches || [];
  let usesS1 = false;
  let usesS2 = false;
  let usesRelay = false;
  let usesL1 = false;
  let usesL2 = false;

  branches.forEach((b) => {
    [b.topSlot, b.midSlot].forEach((s) => {
      if (s === 'S1_NO' || s === 'S1_NC') usesS1 = true;
      if (s === 'S2_NO' || s === 'S2_NC') usesS2 = true;
      if (s === 'K1_NO' || s === 'K1_NC') usesRelay = true;
    });
    if (b.loadSlot === 'L1') usesL1 = true;
    if (b.loadSlot === 'L2') usesL2 = true;
    if (b.loadSlot === 'K1_COIL') usesRelay = true;
  });

  const testCases = [];
  const combos = (usesS2 || usesS1)
    ? [
        { S1: 0, S2: 0 },
        { S1: 0, S2: 1 },
        { S1: 1, S2: 0 },
        { S1: 1, S2: 1 }
      ]
    : [
        { S1: 0 },
        { S1: 1 }
      ];

  let simRelayState = false;
  combos.forEach((c) => {
    const s1 = c.S1 !== undefined ? c.S1 : 0;
    const s2 = c.S2 !== undefined ? c.S2 : 0;
    const sim = simulateCustomSchematic(schematic, s1, s2, simRelayState);
    simRelayState = Boolean(sim.RELAY);

    const expected = {};
    if (usesL1 || (!usesL1 && !usesL2)) expected.L1 = sim.L1;
    if (usesL2) expected.L2 = sim.L2;
    if (usesRelay) expected.RELAY = sim.RELAY;

    testCases.push({
      ...c,
      expected
    });
  });

  return testCases;
}

function generateHintWiresFromSchematic(schematic) {
  const hintWires = [];
  const branches = schematic.branches || [];

  branches.forEach((b, bIdx) => {
    let currentPos = (bIdx === 0) ? 'PWR_POS' : `TB_${bIdx + 1}_T`;

    if (bIdx > 0 && (b.topSlot || b.loadSlot)) {
      hintWires.push({
        from: 'PWR_POS',
        to: `TB_${bIdx + 1}_T`,
        color: '#ef4444',
        waypoints: []
      });
      currentPos = `TB_${bIdx + 1}_B`;
    }

    let topTermOut = null;
    if (b.topSlot === 'S1_NO') {
      hintWires.push({ from: currentPos, to: 'S1_NO_1', color: '#ef4444', waypoints: [] });
      topTermOut = 'S1_NO_2';
    } else if (b.topSlot === 'S1_NC') {
      hintWires.push({ from: currentPos, to: 'S1_NC_1', color: '#ef4444', waypoints: [] });
      topTermOut = 'S1_NC_2';
    } else if (b.topSlot === 'S2_NO') {
      hintWires.push({ from: currentPos, to: 'S2_NO_1', color: '#ef4444', waypoints: [] });
      topTermOut = 'S2_NO_2';
    } else if (b.topSlot === 'S2_NC') {
      hintWires.push({ from: currentPos, to: 'S2_NC_1', color: '#ef4444', waypoints: [] });
      topTermOut = 'S2_NC_2';
    } else if (b.topSlot === 'K1_NO') {
      hintWires.push({ from: currentPos, to: 'K1_9', color: '#eab308', waypoints: [] });
      topTermOut = 'K1_5';
    } else if (b.topSlot === 'K1_NC') {
      hintWires.push({ from: currentPos, to: 'K1_9', color: '#eab308', waypoints: [] });
      topTermOut = 'K1_1';
    } else if (b.topSlot === 'WIRE_V') {
      topTermOut = currentPos;
    }

    let midTermOut = topTermOut;
    if (b.midSlot === 'S1_NO') {
      hintWires.push({ from: topTermOut || currentPos, to: 'S1_NO_1', color: '#ef4444', waypoints: [] });
      midTermOut = 'S1_NO_2';
    } else if (b.midSlot === 'S1_NC') {
      hintWires.push({ from: topTermOut || currentPos, to: 'S1_NC_1', color: '#ef4444', waypoints: [] });
      midTermOut = 'S1_NC_2';
    } else if (b.midSlot === 'S2_NO') {
      hintWires.push({ from: topTermOut || currentPos, to: 'S2_NO_1', color: '#ef4444', waypoints: [] });
      midTermOut = 'S2_NO_2';
    } else if (b.midSlot === 'S2_NC') {
      hintWires.push({ from: topTermOut || currentPos, to: 'S2_NC_1', color: '#ef4444', waypoints: [] });
      midTermOut = 'S2_NC_2';
    } else if (b.midSlot === 'K1_NO') {
      hintWires.push({ from: topTermOut || currentPos, to: 'K1_9', color: '#eab308', waypoints: [] });
      midTermOut = 'K1_5';
    } else if (b.midSlot === 'K1_NC') {
      hintWires.push({ from: topTermOut || currentPos, to: 'K1_9', color: '#eab308', waypoints: [] });
      midTermOut = 'K1_1';
    }

    if (b.loadSlot === 'L1') {
      hintWires.push({ from: midTermOut || currentPos, to: 'L1_A', color: '#3b82f6', waypoints: [] });
      hintWires.push({ from: 'L1_B', to: 'PWR_NEG', color: '#1e293b', waypoints: [] });
    } else if (b.loadSlot === 'L2') {
      hintWires.push({ from: midTermOut || currentPos, to: 'L2_A', color: '#3b82f6', waypoints: [] });
      hintWires.push({ from: 'L2_B', to: 'PWR_NEG', color: '#1e293b', waypoints: [] });
    } else if (b.loadSlot === 'K1_COIL') {
      hintWires.push({ from: midTermOut || currentPos, to: 'K1_14', color: '#3b82f6', waypoints: [] });
      hintWires.push({ from: 'K1_13', to: 'PWR_NEG', color: '#1e293b', waypoints: [] });
    }
  });

  return hintWires;
}

function openPasswordModal() {
  const modal = document.getElementById('teacherPasswordModal');
  const input = document.getElementById('teacherPassInput');
  const err = document.getElementById('teacherPassError');
  if (modal) modal.hidden = false;
  if (input) {
    input.value = '';
    input.focus();
  }
  if (err) err.hidden = true;
}

function closePasswordModal() {
  const modal = document.getElementById('teacherPasswordModal');
  if (modal) modal.hidden = true;
}

function handlePasswordSubmit() {
  const input = document.getElementById('teacherPassInput');
  const err = document.getElementById('teacherPassError');
  const val = (input ? input.value : '').trim().toLowerCase();

  if (val === TEACHER_PASSWORD) {
    closePasswordModal();
    openBuilderModal();
  } else {
    if (err) err.hidden = false;
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function openBuilderModal(labIdToEdit = null) {
  const modal = document.getElementById('customLabModal');
  if (!modal) return;
  modal.hidden = false;

  if (labIdToEdit) {
    editCustomLab(labIdToEdit);
  } else if (!builderState.editingLabId) {
    resetBuilderState();
  }

  renderBuilderCustomLabsList();
  renderBuilderWorkspace();

  // Background fetch latest custom labs from online cloud
  fetchCustomLabsFromServer(true);
}

function closeBuilderModal() {
  const modal = document.getElementById('customLabModal');
  if (modal) modal.hidden = true;
}

function resetBuilderState() {
  builderState.editingLabId = null;
  builderState.title = '';
  builderState.objective = '';
  builderState.logicComparison = '';
  builderState.branches = [
    { topSlot: 'S1_NO', midSlot: 'S2_NO', loadSlot: 'L1' },
    { topSlot: null, midSlot: null, loadSlot: null },
    { topSlot: null, midSlot: null, loadSlot: null }
  ];
  builderState.bridge12 = false;
  builderState.bridge23 = false;
  builderState.selectedPaletteComp = null;
  builderState.selectedPaletteLoad = null;
  builderState.capturedWires = null;
  builderState.truthTable = generateTruthTableForCustomSchematic(builderState);

  const titleInp = document.getElementById('customLabTitle');
  const objInp = document.getElementById('customLabObj');
  const logicInp = document.getElementById('customLabLogic');
  const notice = document.getElementById('capturedWiresNotice');

  if (titleInp) titleInp.value = '';
  if (objInp) objInp.value = '';
  if (logicInp) logicInp.value = '';
  if (notice) notice.hidden = true;
}

function editCustomLab(labId) {
  const lab = LABS[labId] || getStoredCustomLabs()[labId];
  if (!lab) return;

  builderState.editingLabId = labId;
  builderState.title = lab.title || '';
  builderState.objective = lab.objective || '';
  builderState.logicComparison = lab.logicComparison || '';

  if (lab.customSchematic && lab.customSchematic.branches) {
    builderState.branches = JSON.parse(JSON.stringify(lab.customSchematic.branches));
    builderState.bridge12 = Boolean(lab.customSchematic.bridge12);
    builderState.bridge23 = Boolean(lab.customSchematic.bridge23);
  }

  builderState.capturedWires = lab.hintWires ? cloneWires(lab.hintWires) : null;
  builderState.truthTable = lab.truthTable
    ? JSON.parse(JSON.stringify(lab.truthTable))
    : generateTruthTableForCustomSchematic(builderState);

  const titleInp = document.getElementById('customLabTitle');
  const objInp = document.getElementById('customLabObj');
  const logicInp = document.getElementById('customLabLogic');
  const notice = document.getElementById('capturedWiresNotice');
  const countEl = document.getElementById('capturedWiresCount');

  if (titleInp) titleInp.value = builderState.title;
  if (objInp) objInp.value = builderState.objective;
  if (logicInp) logicInp.value = builderState.logicComparison;

  if (notice && countEl) {
    if (builderState.capturedWires && builderState.capturedWires.length > 0) {
      notice.hidden = false;
      countEl.textContent = builderState.capturedWires.length;
    } else {
      notice.hidden = true;
    }
  }

  renderBuilderWorkspace();
  renderBuilderCustomLabsList();
}

function deleteCustomLab(labId) {
  const lab = LABS[labId] || getStoredCustomLabs()[labId];
  const name = lab ? lab.title : labId;
  if (!confirm(`ต้องการลบโจทย์ใบงาน "${name}" ใช่หรือไม่?`)) return;

  recordDeletedCustomLabId(labId);

  const stored = getStoredCustomLabs();
  delete stored[labId];
  saveStoredCustomLabs(stored);

  delete LABS[labId];
  refreshCustomLabsInSelect();
  renderBuilderCustomLabsList();

  if (state.currentLabId === labId) {
    loadLab('lab1_1');
  }
  if (builderState.editingLabId === labId) {
    resetBuilderState();
    renderBuilderWorkspace();
  }

  // Push deletion to online cloud
  pushCustomLabsToServer();
}

function saveCustomLab() {
  const titleInput = document.getElementById('customLabTitle');
  const title = (titleInput ? titleInput.value : '').trim();
  if (!title) {
    alert('กรุณากรอกชื่อโจทย์ใบงาน');
    if (titleInput) titleInput.focus();
    return;
  }

  const obj = (document.getElementById('customLabObj')?.value || '').trim() || 'เชื่อมต่อวงจรตามวงจรสัญลักษณ์ที่กำหนดให้ถูกต้องสมบูรณ์';
  const logic = (document.getElementById('customLabLogic')?.value || '').trim() || 'วงจรควบคุมที่ออกแบบเอง (Custom Control Circuit)';

  let hasS1 = false, hasS2 = false, hasL1 = false, hasL2 = false, hasRelay = false;
  builderState.branches.forEach((b) => {
    [b.topSlot, b.midSlot].forEach((s) => {
      if (s === 'S1_NO' || s === 'S1_NC') hasS1 = true;
      if (s === 'S2_NO' || s === 'S2_NC') hasS2 = true;
      if (s === 'K1_NO' || s === 'K1_NC') hasRelay = true;
    });
    if (b.loadSlot === 'L1') hasL1 = true;
    if (b.loadSlot === 'L2') hasL2 = true;
    if (b.loadSlot === 'K1_COIL') hasRelay = true;
  });

  if (!hasL1 && !hasL2 && !hasRelay) {
    alert('กรุณาวางหลอดไฟ L1 หรือ L2 หรือคอยล์รีเลย์ K1 อย่างน้อย 1 อุปกรณ์ในแถวล่าง');
    return;
  }

  const inputs = (hasS2 || hasS1) ? ['S1', 'S2'] : ['S1'];
  const outputs = [];
  if (hasL1) outputs.push('L1');
  if (hasL2) outputs.push('L2');
  if (outputs.length === 0) outputs.push('L1');

  const labId = builderState.editingLabId || `custom_${Date.now()}`;
  const now = Date.now();
  const labDef = {
    id: labId,
    isCustom: true,
    updatedAt: now,
    title: title,
    objective: obj,
    logicComparison: logic,
    inputs: inputs,
    outputs: outputs,
    showL2: hasL2,
    showS2: hasS2 || inputs.includes('S2'),
    showRelays: hasRelay,
    requireRelay: hasRelay,
    customSchematic: {
      branches: JSON.parse(JSON.stringify(builderState.branches)),
      bridge12: builderState.bridge12,
      bridge23: builderState.bridge23
    },
    truthTable: JSON.parse(JSON.stringify(builderState.truthTable)),
    hintWires: (builderState.capturedWires && builderState.capturedWires.length > 0)
      ? builderState.capturedWires
      : generateHintWiresFromSchematic(builderState)
  };

  LABS[labId] = labDef;
  const stored = getStoredCustomLabs();
  stored[labId] = labDef;
  saveStoredCustomLabs(stored);
  removeDeletedCustomLabId(labId);

  refreshCustomLabsInSelect(labId);
  closeBuilderModal();
  loadLab(labId);

  // Push new/updated lab to online cloud
  pushCustomLabsToServer();
}

function renderBuilderCustomLabsList() {
  const listEl = document.getElementById('customLabsList');
  if (!listEl) return;

  const stored = getStoredCustomLabs();
  const keys = Object.keys(stored);

  if (keys.length === 0) {
    listEl.innerHTML = `
      <div style="font-size:0.78rem;color:#64748b;text-align:center;padding:1.5rem 0.5rem">
        ยังไม่มีโจทย์ที่สร้างไว้<br>กดปุ่ม <b>➕ สร้างโจทย์ใหม่</b> เพื่อเริ่มต้น
      </div>
    `;
    return;
  }

  let html = '';
  keys.forEach((id) => {
    const lab = stored[id];
    const isEditing = builderState.editingLabId === id;
    html += `
      <div class="custom-lab-item ${isEditing ? 'active' : ''}" data-lab-id="${id}">
        <div class="custom-lab-title">${lab.title}</div>
        <div class="custom-lab-meta">${lab.logicComparison || 'Custom Logic'}</div>
        <div class="custom-lab-actions">
          <button type="button" class="btn-mini-action select btn-use-custom" data-lab-id="${id}" title="เปิดใช้งานโจทย์นี้บนกระดานหลัก">▶ เลือกใช้</button>
          <button type="button" class="btn-mini-action btn-edit-custom" data-lab-id="${id}" title="แก้ไขโจทย์นี้">✏️ แก้ไข</button>
          <button type="button" class="btn-mini-action delete btn-del-custom" data-lab-id="${id}" title="ลบโจทย์นี้">🗑️ ลบ</button>
        </div>
      </div>
    `;
  });

  listEl.innerHTML = html;

  listEl.querySelectorAll('.btn-use-custom').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-lab-id');
      closeBuilderModal();
      loadLab(id);
    });
  });

  listEl.querySelectorAll('.btn-edit-custom').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-lab-id');
      editCustomLab(id);
    });
  });

  listEl.querySelectorAll('.btn-del-custom').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-lab-id');
      deleteCustomLab(id);
    });
  });
}

function renderBuilderWorkspace() {
  const btnB12 = document.getElementById('btnToggleBridge12');
  const btnB23 = document.getElementById('btnToggleBridge23');
  if (btnB12) btnB12.classList.toggle('active', builderState.bridge12);
  if (btnB23) btnB23.classList.toggle('active', builderState.bridge23);

  const container = document.getElementById('svgBoardContainer');
  if (container) {
    container.innerHTML = generateCustomSchematicSvg(builderState, {
      builderMode: true
    });

    container.querySelectorAll('.svg-slot-group').forEach((slotGroup) => {
      const b = parseInt(slotGroup.getAttribute('data-branch'), 10);
      const slotType = slotGroup.getAttribute('data-slot');

      slotGroup.addEventListener('dragover', (e) => {
        e.preventDefault();
        slotGroup.classList.add('drag-over');
      });

      slotGroup.addEventListener('dragleave', () => {
        slotGroup.classList.remove('drag-over');
      });

      slotGroup.addEventListener('drop', (e) => {
        e.preventDefault();
        slotGroup.classList.remove('drag-over');
        try {
          const raw = e.dataTransfer.getData('text/plain');
          const data = JSON.parse(raw);
          if (slotType === 'loadSlot' && data.load) {
            builderState.branches[b].loadSlot = data.load === 'EMPTY_LOAD' ? null : data.load;
          } else if ((slotType === 'topSlot' || slotType === 'midSlot') && data.comp) {
            builderState.branches[b][slotType] = data.comp === 'EMPTY' ? null : data.comp;
          }
          builderState.truthTable = generateTruthTableForCustomSchematic(builderState);
          renderBuilderWorkspace();
        } catch (err) {
          console.warn('Drop parse error', err);
        }
      });

      slotGroup.addEventListener('click', () => {
        if (slotType === 'loadSlot') {
          if (builderState.selectedPaletteLoad) {
            builderState.branches[b].loadSlot = builderState.selectedPaletteLoad === 'EMPTY_LOAD' ? null : builderState.selectedPaletteLoad;
          } else {
            builderState.branches[b].loadSlot = null;
          }
        } else {
          if (builderState.selectedPaletteComp) {
            builderState.branches[b][slotType] = builderState.selectedPaletteComp === 'EMPTY' ? null : builderState.selectedPaletteComp;
          } else {
            builderState.branches[b][slotType] = null;
          }
        }
        builderState.truthTable = generateTruthTableForCustomSchematic(builderState);
        renderBuilderWorkspace();
      });
    });
  }

  renderBuilderTruthTablePreview();
}

function renderBuilderTruthTablePreview() {
  const table = document.getElementById('customTruthTablePreview');
  if (!table) return;

  if (!builderState.truthTable || builderState.truthTable.length === 0) {
    builderState.truthTable = generateTruthTableForCustomSchematic(builderState);
  }

  const branches = builderState.branches || [];
  let usesS1 = false, usesS2 = false, usesRelay = false, usesL1 = false, usesL2 = false;
  branches.forEach((b) => {
    [b.topSlot, b.midSlot].forEach((s) => {
      if (s === 'S1_NO' || s === 'S1_NC') usesS1 = true;
      if (s === 'S2_NO' || s === 'S2_NC') usesS2 = true;
      if (s === 'K1_NO' || s === 'K1_NC') usesRelay = true;
    });
    if (b.loadSlot === 'L1') usesL1 = true;
    if (b.loadSlot === 'L2') usesL2 = true;
    if (b.loadSlot === 'K1_COIL') usesRelay = true;
  });

  let headers = '<thead><tr><th>ลำดับ</th>';
  if (usesS1 || usesS2) headers += '<th>S1</th>';
  if (usesS2) headers += '<th>S2</th>';
  if (usesRelay) headers += '<th>Coil K1 (คาดหวัง)</th>';
  if (usesL1 || (!usesL1 && !usesL2)) headers += '<th>LOAD (L1)</th>';
  if (usesL2) headers += '<th>LOAD (L2)</th>';
  headers += '</tr></thead>';

  let rows = '<tbody>';
  builderState.truthTable.forEach((row, idx) => {
    rows += `<tr><td>${idx + 1}</td>`;
    if (usesS1 || usesS2) rows += `<td><b>${row.S1 !== undefined ? row.S1 : 0}</b></td>`;
    if (usesS2) rows += `<td><b>${row.S2 !== undefined ? row.S2 : 0}</b></td>`;

    if (usesRelay) {
      const expRelay = row.expected && row.expected.RELAY !== undefined ? row.expected.RELAY : 0;
      rows += `<td><button type="button" class="toggle-expected-btn val-${expRelay}" data-idx="${idx}" data-key="RELAY">${expRelay} (สลับ)</button></td>`;
    }
    if (usesL1 || (!usesL1 && !usesL2)) {
      const expL1 = row.expected && row.expected.L1 !== undefined ? row.expected.L1 : 0;
      rows += `<td><button type="button" class="toggle-expected-btn val-${expL1}" data-idx="${idx}" data-key="L1">${expL1} (สลับ)</button></td>`;
    }
    if (usesL2) {
      const expL2 = row.expected && row.expected.L2 !== undefined ? row.expected.L2 : 0;
      rows += `<td><button type="button" class="toggle-expected-btn val-${expL2}" data-idx="${idx}" data-key="L2">${expL2} (สลับ)</button></td>`;
    }
    rows += `</tr>`;
  });
  rows += '</tbody>';

  table.innerHTML = headers + rows;

  table.querySelectorAll('.toggle-expected-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rIdx = parseInt(btn.getAttribute('data-idx'), 10);
      const key = btn.getAttribute('data-key');
      if (builderState.truthTable[rIdx] && builderState.truthTable[rIdx].expected) {
        builderState.truthTable[rIdx].expected[key] = builderState.truthTable[rIdx].expected[key] === 1 ? 0 : 1;
        renderBuilderTruthTablePreview();
      }
    });
  });
}

function initCustomLabManager() {
  loadStoredCustomLabsIntoApp();

  const btnOpen = document.getElementById('btnOpenLabBuilder');
  if (btnOpen) {
    btnOpen.addEventListener('click', () => openPasswordModal());
  }

  const btnClosePass = document.getElementById('btnClosePassModal');
  const btnCancelPass = document.getElementById('btnCancelPass');
  const btnSubmitPass = document.getElementById('btnSubmitPass');
  const passInput = document.getElementById('teacherPassInput');

  if (btnClosePass) btnClosePass.addEventListener('click', () => closePasswordModal());
  if (btnCancelPass) btnCancelPass.addEventListener('click', () => closePasswordModal());
  if (btnSubmitPass) btnSubmitPass.addEventListener('click', () => handlePasswordSubmit());
  if (passInput) {
    passInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handlePasswordSubmit();
    });
  }

  const btnCloseBuilder = document.getElementById('btnCloseBuilder');
  const btnNewCustomLab = document.getElementById('btnNewCustomLab');
  const btnToggleBridge12 = document.getElementById('btnToggleBridge12');
  const btnToggleBridge23 = document.getElementById('btnToggleBridge23');
  const btnClearSchem = document.getElementById('btnClearBuilderSchem');
  const btnCaptureWires = document.getElementById('btnCaptureCurrentWires');
  const btnSave = document.getElementById('btnSaveCustomLab');

  if (btnCloseBuilder) btnCloseBuilder.addEventListener('click', () => closeBuilderModal());
  if (btnNewCustomLab) {
    btnNewCustomLab.addEventListener('click', () => {
      resetBuilderState();
      renderBuilderWorkspace();
      renderBuilderCustomLabsList();
    });
  }

  if (btnToggleBridge12) {
    btnToggleBridge12.addEventListener('click', () => {
      builderState.bridge12 = !builderState.bridge12;
      builderState.truthTable = generateTruthTableForCustomSchematic(builderState);
      renderBuilderWorkspace();
    });
  }

  if (btnToggleBridge23) {
    btnToggleBridge23.addEventListener('click', () => {
      builderState.bridge23 = !builderState.bridge23;
      builderState.truthTable = generateTruthTableForCustomSchematic(builderState);
      renderBuilderWorkspace();
    });
  }

  if (btnClearSchem) {
    btnClearSchem.addEventListener('click', () => {
      builderState.branches = [
        { topSlot: null, midSlot: null, loadSlot: null },
        { topSlot: null, midSlot: null, loadSlot: null },
        { topSlot: null, midSlot: null, loadSlot: null }
      ];
      builderState.bridge12 = false;
      builderState.bridge23 = false;
      builderState.capturedWires = null;
      builderState.truthTable = generateTruthTableForCustomSchematic(builderState);
      renderBuilderWorkspace();
    });
  }

  if (btnCaptureWires) {
    btnCaptureWires.addEventListener('click', () => {
      if (state.wires.length === 0) {
        alert('ยังไม่มีสายไฟที่เชื่อมต่อบนกระดานหลัก กรุณาลากสายไฟบนกระดานชุดทดลองก่อนกดปุ่มนี้');
        return;
      }
      builderState.capturedWires = cloneWires(state.wires);
      const notice = document.getElementById('capturedWiresNotice');
      const countEl = document.getElementById('capturedWiresCount');
      if (notice && countEl) {
        notice.hidden = false;
        countEl.textContent = builderState.capturedWires.length;
      }
    });
  }

  if (btnSave) {
    btnSave.addEventListener('click', () => saveCustomLab());
  }

  const btnForceCloudSync = document.getElementById('btnForceCloudSync');
  if (btnForceCloudSync) {
    btnForceCloudSync.addEventListener('click', () => {
      fetchCustomLabsFromServer(false, true);
    });
  }

  const btnMainCloudSync = document.getElementById('btnMainCloudSync');
  if (btnMainCloudSync) {
    btnMainCloudSync.addEventListener('click', () => {
      fetchCustomLabsFromServer(false, true);
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      fetchCustomLabsFromServer(true, true);
    }
  });

  const btnExportCustomLabs = document.getElementById('btnExportCustomLabs');
  if (btnExportCustomLabs) {
    btnExportCustomLabs.addEventListener('click', () => {
      exportCustomLabsJson();
    });
  }

  const btnImportCustomLabs = document.getElementById('btnImportCustomLabs');
  const importCustomLabsInput = document.getElementById('importCustomLabsInput');
  if (btnImportCustomLabs && importCustomLabsInput) {
    btnImportCustomLabs.addEventListener('click', () => {
      importCustomLabsInput.value = '';
      importCustomLabsInput.click();
    });
    importCustomLabsInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleImportCustomLabsFile(e.target.files[0]);
      }
    });
  }

  document.querySelectorAll('#schemPalette .palette-item').forEach((item) => {
    item.addEventListener('dragstart', (e) => {
      const comp = item.getAttribute('data-comp') || null;
      const load = item.getAttribute('data-load') || null;
      e.dataTransfer.setData('text/plain', JSON.stringify({ comp, load }));
      builderState.selectedPaletteComp = comp;
      builderState.selectedPaletteLoad = load;
    });

    item.addEventListener('click', () => {
      const isSelected = item.classList.contains('selected');
      document.querySelectorAll('#schemPalette .palette-item').forEach((p) => p.classList.remove('selected'));
      if (!isSelected) {
        item.classList.add('selected');
        builderState.selectedPaletteComp = item.getAttribute('data-comp') || null;
        builderState.selectedPaletteLoad = item.getAttribute('data-load') || null;
      } else {
        builderState.selectedPaletteComp = null;
        builderState.selectedPaletteLoad = null;
      }
    });
  });
}

// ============================================================================
// PLC Modicon TM221CE16R & Ladder Diagram Co-Simulation Engine
// ============================================================================

const plcState = {
  syncWithActualWiring: true,
  showIlDrawer: false,
  idealMemoryM0: false
};

function getPlcSimulationState() {
  const lab = (typeof state !== 'undefined' && state.currentLabId) ? LABS[state.currentLabId] : null;
  const labId = (typeof state !== 'undefined') ? state.currentLabId : 'lab1_1';
  const rawS1 = Boolean(state.switches && state.switches.S1 && state.switches.S1.pressed);
  const rawS2 = Boolean(state.switches && state.switches.S2 && state.switches.S2.pressed);
  const pwr = Boolean(state.powerOn);
  const isPlcLab = Boolean(lab && lab.isPlcTerminalLab);
  const hasWires = Boolean(state.wires && state.wires.length > 0);
  const isSyncMode = Boolean(plcState.syncWithActualWiring && hasWires);

  // 1. Calculate Ideal PLC scan logic for current lab using raw switch inputs
  let idealM0 = false;
  let idealQ0 = false;
  let idealQ1 = false;

  if (labId === 'lab1_1') {
    idealM0 = false;
    idealQ0 = pwr && rawS1 && rawS2;
    idealQ1 = false;
  } else if (labId === 'lab1_2') {
    idealM0 = false;
    idealQ0 = pwr && (!rawS1 || !rawS2);
    idealQ1 = false;
  } else if (labId === 'lab1_ex') {
    idealM0 = false;
    idealQ0 = pwr && (!rawS1 && !rawS2);
    idealQ1 = false;
  } else if (labId === 'lab2_1') {
    idealM0 = pwr && rawS1;
    idealQ0 = pwr && idealM0;
    idealQ1 = false;
  } else if (labId === 'lab2_2') {
    idealM0 = pwr && rawS1;
    idealQ0 = pwr && idealM0;
    idealQ1 = pwr && !idealM0;
  } else if (labId === 'lab2_latch') {
    if (!pwr) {
      plcState.idealMemoryM0 = false;
    } else {
      if (rawS2) {
        plcState.idealMemoryM0 = false; // Stop button pressed
      } else if (rawS1) {
        plcState.idealMemoryM0 = true;  // Start button pressed
      }
    }
    idealM0 = pwr && plcState.idealMemoryM0;
    idealQ0 = pwr && idealM0;
    idealQ1 = false;
  } else if (labId === 'lab4_1') {
    idealM0 = false;
    idealQ0 = pwr && rawS1;
    idealQ1 = pwr && !rawS1;
  } else if (labId === 'lab4_2') {
    idealM0 = false;
    idealQ0 = pwr && rawS1 && rawS2;
    idealQ1 = false;
  } else if (labId === 'lab5_1') {
    idealM0 = false;
    idealQ0 = pwr && rawS1;
    idealQ1 = false;
  } else if (labId === 'lab5_2') {
    idealM0 = false;
    idealQ0 = pwr && !rawS1;
    idealQ1 = pwr && rawS1;
  } else if (lab && lab.customSchematic) {
    if (!pwr) {
      plcState.idealMemoryM0 = false;
    }
    const sim = simulateCustomSchematic(lab.customSchematic, rawS1 ? 1 : 0, rawS2 ? 1 : 0, plcState.idealMemoryM0);
    if (pwr) {
      plcState.idealMemoryM0 = Boolean(sim.RELAY);
    }
    idealM0 = pwr && Boolean(sim.RELAY);
    idealQ0 = pwr && Boolean(sim.L1);
    idealQ1 = pwr && Boolean(sim.L2);
  }

  // Electrical inputs reaching the PLC in Sync Mode
  const s1 = (isPlcLab && isSyncMode && state.simResult && state.simResult.plcInputs)
    ? Boolean(state.simResult.plcInputs[0])
    : rawS1;
  const s2 = (isPlcLab && isSyncMode && state.simResult && state.simResult.plcInputs)
    ? Boolean(state.simResult.plcInputs[1])
    : rawS2;

  // 2. Physical Board State (actual wiring)
  const actualM0 = Boolean(pwr && state.simResult && (state.simResult.K1 || state.simResult.K2));
  const actualQ0 = Boolean(pwr && state.simResult && state.simResult.L1);
  const actualQ1 = Boolean(pwr && state.simResult && state.simResult.L2);

  // 3. Determine active display states based on mode
  const activeM0 = isSyncMode ? actualM0 : idealM0;
  const activeQ0 = isSyncMode ? actualQ0 : idealQ0;
  const activeQ1 = isSyncMode ? actualQ1 : idealQ1;

  // Comparison between actual board and ideal PLC logic
  const isMatching = (actualM0 === idealM0) && (actualQ0 === idealQ0) && (actualQ1 === idealQ1);

  return {
    s1,
    s2,
    rawS1,
    rawS2,
    pwr,
    idealM0,
    idealQ0,
    idealQ1,
    actualM0,
    actualQ0,
    actualQ1,
    activeM0,
    activeQ0,
    activeQ1,
    hasWires,
    isSyncMode,
    isMatching,
    labId,
    lab
  };
}

function drawLadderWire(x1, y1, x2, y2, isHot) {
  const stroke = isHot ? '#22c55e' : '#475569';
  const width = isHot ? '2.8' : '2';
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" />`;
}

function drawLadderContactNO(cx, cy, address, symbol, closed, isHotIn, swTarget = null) {
  const isHotOut = isHotIn && closed;
  const inColor = isHotIn ? '#22c55e' : '#64748b';
  const outColor = isHotOut ? '#22c55e' : '#64748b';
  const link = closed
    ? `<line x1="${cx - 6}" y1="${cy}" x2="${cx + 6}" y2="${cy}" stroke="#22c55e" stroke-width="3.5" /><circle cx="${cx}" cy="${cy}" r="2" fill="#4ade80" />`
    : '';

  const hitTagOpen = swTarget ? `<g class="ladder-sw-hit" data-sw="${swTarget}" title="คลิกเพื่อสลับสวิตช์ ${swTarget}">` : '<g>';
  const hitRect = swTarget ? `<rect x="${cx - 18}" y="${cy - 22}" width="36" height="44" fill="transparent" class="hit-area" rx="4" />` : '';

  return `
    ${hitTagOpen}
      ${drawLadderWire(cx - 16, cy, cx - 6, cy, isHotIn)}
      <line x1="${cx - 6}" y1="${cy - 9}" x2="${cx - 6}" y2="${cy + 9}" stroke="${inColor}" stroke-width="2.5" stroke-linecap="round" />
      <line x1="${cx + 6}" y1="${cy - 9}" x2="${cx + 6}" y2="${cy + 9}" stroke="${outColor}" stroke-width="2.5" stroke-linecap="round" />
      ${link}
      ${drawLadderWire(cx + 6, cy, cx + 16, cy, isHotOut)}
      <text x="${cx}" y="${cy - 12}" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="${closed ? '#4ade80' : '#38bdf8'}" text-anchor="middle">${address}</text>
      <text x="${cx}" y="${cy + 20}" font-family="'JetBrains Mono', monospace" font-size="9" font-weight="600" fill="#cbd5e1" text-anchor="middle">${symbol}</text>
      ${hitRect}
    </g>
  `;
}

function drawLadderContactNC(cx, cy, address, symbol, closed, isHotIn, swTarget = null) {
  const isHotOut = isHotIn && closed;
  const inColor = isHotIn ? '#22c55e' : '#64748b';
  const outColor = isHotOut ? '#22c55e' : '#64748b';
  const slashColor = closed ? '#22c55e' : '#ef4444';
  const link = closed
    ? `<line x1="${cx - 6}" y1="${cy}" x2="${cx + 6}" y2="${cy}" stroke="#22c55e" stroke-width="3" />`
    : '';

  const hitTagOpen = swTarget ? `<g class="ladder-sw-hit" data-sw="${swTarget}" title="คลิกเพื่อสลับสวิตช์ ${swTarget}">` : '<g>';
  const hitRect = swTarget ? `<rect x="${cx - 18}" y="${cy - 22}" width="36" height="44" fill="transparent" class="hit-area" rx="4" />` : '';

  return `
    ${hitTagOpen}
      ${drawLadderWire(cx - 16, cy, cx - 6, cy, isHotIn)}
      <line x1="${cx - 6}" y1="${cy - 9}" x2="${cx - 6}" y2="${cy + 9}" stroke="${inColor}" stroke-width="2.5" stroke-linecap="round" />
      <line x1="${cx + 6}" y1="${cy - 9}" x2="${cx + 6}" y2="${cy + 9}" stroke="${outColor}" stroke-width="2.5" stroke-linecap="round" />
      ${link}
      <line x1="${cx - 8}" y1="${cy + 10}" x2="${cx + 8}" y2="${cy - 10}" stroke="${slashColor}" stroke-width="2.5" stroke-linecap="round" />
      ${drawLadderWire(cx + 6, cy, cx + 16, cy, isHotOut)}
      <text x="${cx}" y="${cy - 12}" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="${closed ? '#4ade80' : '#38bdf8'}" text-anchor="middle">${address}</text>
      <text x="${cx}" y="${cy + 20}" font-family="'JetBrains Mono', monospace" font-size="9" font-weight="600" fill="#cbd5e1" text-anchor="middle">${symbol}</text>
      ${hitRect}
    </g>
  `;
}

function drawLadderCoil(cx, cy, address, symbol, energized, coilType = 'out', isHotIn = false) {
  let strokeColor = '#475569';
  let fillColor = 'none';
  let labelColor = '#94a3b8';
  let dot = '';

  if (energized) {
    if (coilType === 'mem') {
      strokeColor = '#c084fc';
      fillColor = 'rgba(168, 85, 247, 0.35)';
      labelColor = '#d8b4fe';
      dot = `<circle cx="${cx}" cy="${cy}" r="3.2" fill="#c084fc" />`;
    } else {
      strokeColor = '#fde047';
      fillColor = 'rgba(250, 204, 21, 0.35)';
      labelColor = '#fde047';
      dot = `<circle cx="${cx}" cy="${cy}" r="3.2" fill="#facc15" />`;
    }
  }

  return `
    <g>
      ${drawLadderWire(cx - 16, cy, cx - 6, cy, isHotIn)}
      <path d="M ${cx - 6} ${cy - 11} A 12 12 0 0 0 ${cx - 6} ${cy + 11}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="2.6" stroke-linecap="round" />
      <path d="M ${cx + 6} ${cy - 11} A 12 12 0 0 1 ${cx + 6} ${cy + 11}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="2.6" stroke-linecap="round" />
      ${dot}
      ${drawLadderWire(cx + 6, cy, cx + 16, cy, false)}
      <text x="${cx}" y="${cy - 14}" font-family="'JetBrains Mono', monospace" font-size="10.5" font-weight="700" fill="${labelColor}" text-anchor="middle">${address}</text>
      <text x="${cx}" y="${cy + 21}" font-family="'JetBrains Mono', monospace" font-size="9.5" font-weight="600" fill="#e2e8f0" text-anchor="middle">${symbol}</text>
    </g>
  `;
}

function generateCustomPlcIl(schematic) {
  const branches = (schematic && schematic.branches) ? schematic.branches : [];
  const spec = getPlcModelSpec();
  let il = `${spec.ilHeader}\n`;
  let rungIdx = 0;

  branches.forEach((b, idx) => {
    if (!b || (!b.loadSlot && !b.topSlot && !b.midSlot)) return;
    il += `(* Rung ${rungIdx}: Branch ${idx + 1} *)\n`;
    const comps = [];
    if (b.topSlot) comps.push(b.topSlot);
    if (b.midSlot) comps.push(b.midSlot);

    comps.forEach((comp, cIdx) => {
      const opPrefix = (cIdx === 0) ? spec.ilLd : spec.ilAnd;
      const opPrefixN = (cIdx === 0) ? spec.ilLdn : spec.ilAndn;
      if (comp === 'S1_NO') il += `${opPrefix}   ${spec.in0}    (* S1 NO *)\n`;
      else if (comp === 'S1_NC') il += `${opPrefixN}  ${spec.in0}    (* S1 NC *)\n`;
      else if (comp === 'S2_NO') il += `${opPrefix}   ${spec.in1}    (* S2 NO *)\n`;
      else if (comp === 'S2_NC') il += `${opPrefixN}  ${spec.in1}    (* S2 NC *)\n`;
      else if (comp === 'K1_NO') il += `${opPrefix}   ${spec.mem0}      (* K1 NO *)\n`;
      else if (comp === 'K1_NC') il += `${opPrefixN}  ${spec.mem0}      (* K1 NC *)\n`;
      else if (comp === 'WIRE_V') il += `(* Conductor *)\n`;
    });

    if (b.loadSlot === 'K1_COIL') il += `${spec.ilOut}   ${spec.mem0}      (* K1 Coil *)\n\n`;
    else if (b.loadSlot === 'L1') il += `${spec.ilOut}   ${spec.out0}    (* Lamp L1 *)\n\n`;
    else if (b.loadSlot === 'L2') il += `${spec.ilOut}   ${spec.out1}    (* Lamp L2 *)\n\n`;
    else il += `\n`;
    rungIdx++;
  });

  return il.trim();
}

function updatePlcAddressTable(pState) {
  const tbody = document.getElementById('plcAddrTableBody');
  if (!tbody) return;

  const spec = getPlcModelSpec();
  const rows = [];
  const s1Val = pState.s1;
  const s2Val = pState.s2;
  const m0Val = pState.activeM0;
  const q0Val = pState.activeQ0;
  const q1Val = pState.activeQ1;

  const isPlcLab = (pState.labId && (pState.labId.startsWith('lab4') || pState.labId.startsWith('lab5')));

  // S1 is always used
  rows.push({
    device: isPlcLab ? 'สวิตช์ PB1 (S1)' : 'สวิตช์ S1',
    address: spec.in0,
    type: 'Digital Input (24VDC)',
    val: s1Val ? '1 (ON / กดติด)' : '0 (OFF / ปล่อย)',
    isOn: s1Val
  });

  // S2
  if (!pState.lab || pState.lab.showS2 || (pState.lab.inputs && pState.lab.inputs.includes('S2'))) {
    rows.push({
      device: isPlcLab ? 'สวิตช์ PB2 (S2)' : 'สวิตช์ S2',
      address: spec.in1,
      type: 'Digital Input (24VDC)',
      val: s2Val ? '1 (ON / กดติด)' : '0 (OFF / ปล่อย)',
      isOn: s2Val
    });
  }

  // K1 (Memory bit)
  if (pState.lab && (pState.lab.requireRelay || pState.lab.showRelays || (pState.lab.customSchematic && JSON.stringify(pState.lab.customSchematic).includes('K1')))) {
    rows.push({
      device: 'รีเลย์ K1 (Coil & Contacts)',
      address: spec.mem0,
      type: `Internal Memory Bit (${spec.mem0.startsWith('%') ? '%M' : 'M'})`,
      val: m0Val ? '1 (SET / คอยล์ทำงาน)' : '0 (RESET / คอยล์พัก)',
      isOn: m0Val
    });
  }

  // L1 / PL1
  rows.push({
    device: isPlcLab ? 'หลอดไฟ PL1 (แดง)' : 'หลอดไฟ L1 (LOAD)',
    address: spec.out0,
    type: 'Relay Output (NO 2A)',
    val: q0Val ? '1 (ON / สว่าง)' : '0 (OFF / ดับ)',
    isOn: q0Val
  });

  // L2 / PL2
  if (pState.lab && (pState.lab.showL2 || (pState.lab.outputs && pState.lab.outputs.includes('L2')) || (pState.lab.customSchematic && JSON.stringify(pState.lab.customSchematic).includes('L2')))) {
    rows.push({
      device: isPlcLab ? 'หลอดไฟ PL2 (เขียว)' : 'หลอดไฟ L2',
      address: spec.out1,
      type: 'Relay Output (NO 2A)',
      val: q1Val ? '1 (ON / สว่าง)' : '0 (OFF / ดับ)',
      isOn: q1Val
    });
  }

  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td><b>${r.device}</b></td>
      <td><code>${r.address}</code></td>
      <td>${r.type}</td>
      <td class="${r.isOn ? 'val-on' : 'val-off'}">${r.val}</td>
    </tr>
  `).join('');
}

function updateTm221HwStrip(pState) {
  const inRow = document.getElementById('tm221InputsRow');
  const memRow = document.getElementById('tm221MemRow');
  const outRow = document.getElementById('tm221OutputsRow');
  const ledPwr = document.getElementById('plcLedPwr');
  const ledRun = document.getElementById('plcLedRun');
  const ledErr = document.getElementById('plcLedErr');

  if (ledPwr) {
    ledPwr.className = 'plc-led on';
  }
  if (ledRun) {
    ledRun.className = `plc-led ${pState.pwr ? 'on' : ''}`;
  }
  if (ledErr) {
    const isErr = Boolean(state.simResult && state.simResult.shortCircuit);
    ledErr.className = `plc-led ${isErr ? 'err' : ''}`;
  }

  const spec = getPlcModelSpec();
  const lab = pState.lab;
  const hasS2 = !lab || lab.showS2 || (lab.inputs && lab.inputs.includes('S2'));
  const hasK1 = lab && (lab.requireRelay || lab.showRelays || (lab.customSchematic && JSON.stringify(lab.customSchematic).includes('K1')));
  const hasL2 = lab && (lab.showL2 || (lab.outputs && lab.outputs.includes('L2')) || (lab.customSchematic && JSON.stringify(lab.customSchematic).includes('L2')));

  if (inRow) {
    let html = `<span class="io-pin-pill clickable ${pState.s1 ? 'active-in' : ''}" data-sw="S1" title="คลิกเพื่อสลับสวิตช์ S1">${spec.in0}(S1)</span>`;
    if (hasS2) {
      html += `<span class="io-pin-pill clickable ${pState.s2 ? 'active-in' : ''}" data-sw="S2" title="คลิกเพื่อสลับสวิตช์ S2">${spec.in1}(S2)</span>`;
    } else {
      html += `<span class="io-pin-pill" style="opacity:0.35;">${spec.in1}</span>`;
    }
    html += `<span class="io-pin-pill" style="opacity:0.35;">${spec.in2}</span>`;
    html += `<span class="io-pin-pill" style="opacity:0.35;">${spec.in3}</span>`;
    inRow.innerHTML = html;
  }

  if (memRow) {
    let html = '';
    if (hasK1) {
      html += `<span class="io-pin-pill ${pState.activeM0 ? 'active-mem' : ''}">${spec.mem0}(K1)</span>`;
    } else {
      html += `<span class="io-pin-pill" style="opacity:0.35;">${spec.mem0}</span>`;
    }
    html += `<span class="io-pin-pill" style="opacity:0.35;">${spec.mem1}</span>`;
    memRow.innerHTML = html;
  }

  if (outRow) {
    let html = `<span class="io-pin-pill ${pState.activeQ0 ? 'active-out' : ''}">${spec.out0}(L1)</span>`;
    if (hasL2) {
      html += `<span class="io-pin-pill ${pState.activeQ1 ? 'active-out' : ''}">${spec.out1}(L2)</span>`;
    } else {
      html += `<span class="io-pin-pill" style="opacity:0.35;">${spec.out1}</span>`;
    }
    html += `<span class="io-pin-pill" style="opacity:0.35;">${spec.out2}</span>`;
    html += `<span class="io-pin-pill" style="opacity:0.35;">${spec.out3}</span>`;
    outRow.innerHTML = html;
  }
}

function updatePlcIlCode(pState) {
  const codeEl = document.getElementById('plcIlCode');
  if (!codeEl) return;

  const spec = getPlcModelSpec();
  const labId = pState.labId;
  let code = '';

  if (labId === 'lab1_1') {
    code = `${spec.ilHeader}
(* Rung 0: Series AND Logic *)
${spec.ilLd}   ${spec.in0}    (* S1 NO Pushbutton *)
${spec.ilAnd}  ${spec.in1}    (* S2 NO Pushbutton *)
${spec.ilOut}   ${spec.out0}    (* Lamp LOAD L1 *)`;
  } else if (labId === 'lab1_2') {
    code = `${spec.ilHeader}
(* Rung 0: Parallel NC - NAND Logic *)
${spec.ilLdn}  ${spec.in0}    (* S1 NC Pushbutton *)
${spec.ilOrn}  ${spec.in1}    (* S2 NC Pushbutton *)
${spec.ilOut}   ${spec.out0}    (* Lamp LOAD L1 *)`;
  } else if (labId === 'lab1_ex') {
    code = `${spec.ilHeader}
(* Rung 0: Series NC - NOR Logic *)
${spec.ilLdn}  ${spec.in0}    (* S1 NC Pushbutton *)
${spec.ilAndn} ${spec.in1}    (* S2 NC Pushbutton *)
${spec.ilOut}   ${spec.out0}    (* Lamp LOAD L1 *)`;
  } else if (labId === 'lab2_1') {
    code = `${spec.ilHeader}
(* Rung 0: Relay Control Coil *)
${spec.ilLd}   ${spec.in0}    (* S1 NO Pushbutton *)
${spec.ilOut}   ${spec.mem0}      (* K1 Internal Relay *)

(* Rung 1: Load Output *)
${spec.ilLd}   ${spec.mem0}      (* K1 NO Contact *)
${spec.ilOut}   ${spec.out0}    (* Lamp LOAD L1 *)`;
  } else if (labId === 'lab2_2') {
    code = `${spec.ilHeader}
(* Rung 0: Relay Control Coil *)
${spec.ilLd}   ${spec.in0}    (* S1 NO Pushbutton *)
${spec.ilOut}   ${spec.mem0}      (* K1 Internal Relay *)

(* Rung 1: Lamp L1 via NO Contact *)
${spec.ilLd}   ${spec.mem0}      (* K1 NO Contact *)
${spec.ilOut}   ${spec.out0}    (* Lamp L1 *)

(* Rung 2: Lamp L2 via NC Contact *)
${spec.ilLdn}  ${spec.mem0}      (* K1 NC Contact *)
${spec.ilOut}   ${spec.out1}    (* Lamp L2 *)`;
  } else if (labId === 'lab2_latch') {
    code = `${spec.ilHeader}
(* Rung 0: Self-Holding Start/Stop Latch *)
${spec.ilLd}   ${spec.in0}    (* S1 Start NO *)
${spec.ilOr}   ${spec.mem0}      (* K1 Seal-in NO *)
${spec.ilAndn} ${spec.in1}    (* S2 Stop NC *)
${spec.ilOut}   ${spec.mem0}      (* K1 Internal Relay *)

(* Rung 1: Lamp Output *)
${spec.ilLd}   ${spec.mem0}      (* K1 NO Contact *)
${spec.ilOut}   ${spec.out0}    (* Lamp LOAD L1 *)`;
  } else if (labId === 'lab4_1') {
    code = `${spec.ilHeader}
(* Lab 4.1: การเชื่อมต่อสวิตช์อินพุต PLC *)
(* Rung 0: S1 (PB1) NO ควบคุม Output 0 *)
${spec.ilLd}   ${spec.in0}    (* S1 NO Contact *)
${spec.ilOut}   ${spec.out0}    (* Output 0 *)

(* Rung 1: S1 (PB1) NC ควบคุม Output 1 *)
${spec.ilLdn}  ${spec.in0}    (* S1 Inverted Contact *)
${spec.ilOut}   ${spec.out1}    (* Output 1 *)`;
  } else if (labId === 'lab4_2') {
    code = `${spec.ilHeader}
(* Lab 4.2: เชื่อมต่ออินพุต S1, S2 ควบคุมเอาต์พุต (AND Logic) *)
(* Rung 0: S1 NO AND S2 NO -> Output 0 *)
${spec.ilLd}   ${spec.in0}    (* S1 NO Contact *)
${spec.ilAnd}  ${spec.in1}    (* S2 NO Contact *)
${spec.ilOut}   ${spec.out0}    (* Output 0 *)`;
  } else if (labId === 'lab5_1') {
    code = `${spec.ilHeader}
(* Lab 5.1: เชื่อมต่ออินพุตและเอาต์พุต PLC (PB1 ควบคุม PL1) *)
(* Rung 0: PB1 NO ควบคุมหลอดไฟ PL1 *)
${spec.ilLd}   ${spec.in0}    (* PB1 NO Contact *)
${spec.ilOut}   ${spec.out0}    (* Output 0 (PL1) *)`;
  } else if (labId === 'lab5_2') {
    code = `${spec.ilHeader}
(* Lab 5.2: PB1 ควบคุมหลอดไฟ PL1 (แดง) และ PL2 (เขียว) สลับกัน *)
(* Rung 0: ปกติไม่กด (NC) -> PL1 แดงติด *)
${spec.ilLdn}  ${spec.in0}    (* PB1 Inverted (Not Pressed) *)
${spec.ilOut}   ${spec.out0}    (* Output 0 (PL1 Red) *)

(* Rung 1: เมื่อกด (NO) -> PL2 เขียวติด *)
${spec.ilLd}   ${spec.in0}    (* PB1 Pressed *)
${spec.ilOut}   ${spec.out1}    (* Output 1 (PL2 Green) *)`;
  } else if (pState.lab && pState.lab.customSchematic) {
    code = generateCustomPlcIl(pState.lab.customSchematic);
  } else {
    code = `${spec.ilHeader}
${spec.ilLd}   ${spec.in0}
${spec.ilOut}   ${spec.out0}`;
  }

  codeEl.textContent = code;
}

function updatePlcFooterStatus(pState) {
  const statusEl = document.getElementById('plcSyncStatusText');
  if (!statusEl) return;

  const spec = getPlcModelSpec();
  if (pState.isSyncMode) {
    if (pState.isMatching) {
      statusEl.innerHTML = `⚡ ซิงค์ชุดฝึกจริง: ✅ <strong style="color: #4ade80;">ผลลัพธ์ตรงกับโปรแกรม PLC ${spec.shortName}</strong> (วงจรที่ต่อทำงานสอดคล้องกับลอจิกโปรแกรม)`;
    } else {
      statusEl.innerHTML = `⚡ ซิงค์ชุดฝึกจริง: ⚠️ <strong style="color: #f59e0b;">ผลลัพธ์วงจรจริงยังไม่ตรงกับลอจิก PLC</strong> (โปรดตรวจสอบการต่อสาย หรือสลับเป็นโหมดลอจิก PLC)`;
    }
  } else {
    statusEl.innerHTML = `⚡ <strong style="color: #38bdf8;">โหมดลอจิก PLC อัตโนมัติ (${spec.shortName})</strong>: ทดลองกด S1 (${spec.in0}) / S2 (${spec.in1}) บนกระดานหรือคลิกที่หน้าสัมผัสใน Ladder เพื่อดูผลทันที`;
  }
}

function renderPlcLadderDiagram() {
  const container = document.getElementById('ladderViewport');
  if (!container) return;

  const spec = getPlcModelSpec();
  const pState = getPlcSimulationState();
  const labId = pState.labId;
  let svgContent = '';

  if (labId === 'lab1_1') {
    // 1 Rung: S1 NO series with S2 NO -> Q0.0 / Y0 (L1)
    const H = 88;
    const y = 44;
    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>

        <text x="4" y="47" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R0</text>
        ${drawLadderWire(22, y, 90 - 16, y, pState.pwr)}
        ${drawLadderContactNO(90, y, spec.in0, 'S1', pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(90 + 16, y, 180 - 16, y, pState.pwr && pState.s1)}
        ${drawLadderContactNO(180, y, spec.in1, 'S2', pState.s2, pState.pwr && pState.s1, 'S2')}
        ${drawLadderWire(180 + 16, y, 295 - 16, y, pState.pwr && pState.s1 && pState.s2)}
        ${drawLadderCoil(295, y, spec.out0, 'L1', pState.activeQ0, 'out', pState.pwr && pState.s1 && pState.s2)}
        ${drawLadderWire(295 + 16, y, 358, y, false)}
      </svg>
    `;
  } else if (labId === 'lab1_2') {
    // 1 Rung with Parallel NC Branches: S1 NC || S2 NC -> Q0.0 / Y0 (L1)
    const H = 136;
    const y1 = 44;
    const y2 = 94;
    const hotTopOut = pState.pwr && !pState.s1;
    const hotBotOut = pState.pwr && !pState.s2;
    const hotMid = hotTopOut || hotBotOut;

    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>

        <text x="4" y="47" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R0</text>
        ${drawLadderWire(22, y1, 60, y1, pState.pwr)}
        <circle cx="60" cy="${y1}" r="2.5" fill="${pState.pwr ? '#22c55e' : '#475569'}" />
        ${drawLadderWire(60, y1, 60, y2, pState.pwr)}
        <circle cx="60" cy="${y2}" r="2.5" fill="${pState.pwr ? '#22c55e' : '#475569'}" />

        ${drawLadderWire(60, y1, 125 - 16, y1, pState.pwr)}
        ${drawLadderContactNC(125, y1, spec.in0, 'S1', !pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(125 + 16, y1, 195, y1, hotTopOut)}

        ${drawLadderWire(60, y2, 125 - 16, y2, pState.pwr)}
        ${drawLadderContactNC(125, y2, spec.in1, 'S2', !pState.s2, pState.pwr, 'S2')}
        ${drawLadderWire(125 + 16, y2, 195, y2, hotBotOut)}

        ${drawLadderWire(195, y2, 195, y1, hotBotOut)}
        <circle cx="195" cy="${y1}" r="2.5" fill="${hotMid ? '#22c55e' : '#475569'}" />

        ${drawLadderWire(195, y1, 295 - 16, y1, hotMid)}
        ${drawLadderCoil(295, y1, spec.out0, 'L1', pState.activeQ0, 'out', hotMid)}
        ${drawLadderWire(295 + 16, y1, 358, y1, false)}
      </svg>
    `;
  } else if (labId === 'lab1_ex') {
    // 1 Rung: Series NC Contacts: S1 NC and S2 NC -> Q0.0 / Y0 (L1)
    const H = 88;
    const y = 44;
    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>

        <text x="4" y="47" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R0</text>
        ${drawLadderWire(22, y, 90 - 16, y, pState.pwr)}
        ${drawLadderContactNC(90, y, spec.in0, 'S1', !pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(90 + 16, y, 180 - 16, y, pState.pwr && !pState.s1)}
        ${drawLadderContactNC(180, y, spec.in1, 'S2', !pState.s2, pState.pwr && !pState.s1, 'S2')}
        ${drawLadderWire(180 + 16, y, 295 - 16, y, pState.pwr && !pState.s1 && !pState.s2)}
        ${drawLadderCoil(295, y, spec.out0, 'L1', pState.activeQ0, 'out', pState.pwr && !pState.s1 && !pState.s2)}
        ${drawLadderWire(295 + 16, y, 358, y, false)}
      </svg>
    `;
  } else if (labId === 'lab2_1') {
    // 2 Rungs:
    // R0: S1 NO -> %M0 / M0 (K1)
    // R1: %M0 / M0 NO -> %Q0.0 / Y0 (L1)
    const H = 155;
    const y0 = 42;
    const y1 = 112;
    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>

        <!-- Rung 0: Control Coil -->
        <text x="4" y="${y0 + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R0</text>
        ${drawLadderWire(22, y0, 110 - 16, y0, pState.pwr)}
        ${drawLadderContactNO(110, y0, spec.in0, 'S1', pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(110 + 16, y0, 295 - 16, y0, pState.pwr && pState.s1)}
        ${drawLadderCoil(295, y0, spec.mem0, 'K1', pState.activeM0, 'mem', pState.pwr && pState.s1)}
        ${drawLadderWire(295 + 16, y0, 358, y0, false)}

        <!-- Rung 1: Output Lamp -->
        <text x="4" y="${y1 + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R1</text>
        ${drawLadderWire(22, y1, 110 - 16, y1, pState.pwr)}
        ${drawLadderContactNO(110, y1, spec.mem0, 'K1', pState.activeM0, pState.pwr, null)}
        ${drawLadderWire(110 + 16, y1, 295 - 16, y1, pState.pwr && pState.activeM0)}
        ${drawLadderCoil(295, y1, spec.out0, 'L1', pState.activeQ0, 'out', pState.pwr && pState.activeM0)}
        ${drawLadderWire(295 + 16, y1, 358, y1, false)}
      </svg>
    `;
  } else if (labId === 'lab2_2') {
    // 3 Rungs:
    // R0: S1 NO -> %M0 (K1)
    // R1: %M0 NO -> %Q0.0 (L1)
    // R2: %M0 NC -> %Q0.1 (L2)
    const H = 220;
    const y0 = 38;
    const y1 = 104;
    const y2 = 170;
    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>

        <!-- Rung 0: Control Coil -->
        <text x="4" y="${y0 + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R0</text>
        ${drawLadderWire(22, y0, 110 - 16, y0, pState.pwr)}
        ${drawLadderContactNO(110, y0, spec.in0, 'S1', pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(110 + 16, y0, 295 - 16, y0, pState.pwr && pState.s1)}
        ${drawLadderCoil(295, y0, spec.mem0, 'K1', pState.activeM0, 'mem', pState.pwr && pState.s1)}
        ${drawLadderWire(295 + 16, y0, 358, y0, false)}

        <!-- Rung 1: Lamp L1 via NO -->
        <text x="4" y="${y1 + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R1</text>
        ${drawLadderWire(22, y1, 110 - 16, y1, pState.pwr)}
        ${drawLadderContactNO(110, y1, spec.mem0, 'K1', pState.activeM0, pState.pwr, null)}
        ${drawLadderWire(110 + 16, y1, 295 - 16, y1, pState.pwr && pState.activeM0)}
        ${drawLadderCoil(295, y1, spec.out0, 'L1', pState.activeQ0, 'out', pState.pwr && pState.activeM0)}
        ${drawLadderWire(295 + 16, y1, 358, y1, false)}

        <!-- Rung 2: Lamp L2 via NC -->
        <text x="4" y="${y2 + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R2</text>
        ${drawLadderWire(22, y2, 110 - 16, y2, pState.pwr)}
        ${drawLadderContactNC(110, y2, spec.mem0, 'K1', !pState.activeM0, pState.pwr, null)}
        ${drawLadderWire(110 + 16, y2, 295 - 16, y2, pState.pwr && !pState.activeM0)}
        ${drawLadderCoil(295, y2, spec.out1, 'L2', pState.activeQ1, 'out', pState.pwr && !pState.activeM0)}
        ${drawLadderWire(295 + 16, y2, 358, y2, false)}
      </svg>
    `;
  } else if (labId === 'lab2_latch') {
    // 2 Rungs:
    // R0: (Start || Latch) in series with Stop NC -> Coil
    // R1: Latch NO -> Lamp Output
    const H = 195;
    const y0 = 42;
    const y0b = 88;
    const y1 = 148;
    const hotTopOut = pState.pwr && pState.s1;
    const hotBotOut = pState.pwr && pState.activeM0;
    const hotConverge = hotTopOut || hotBotOut;
    const hotStopOut = hotConverge && !pState.s2;

    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>

        <!-- Rung 0: Self-Holding Start/Stop -->
        <text x="4" y="${y0 + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R0</text>
        ${drawLadderWire(22, y0, 45, y0, pState.pwr)}
        <circle cx="45" cy="${y0}" r="2.5" fill="${pState.pwr ? '#22c55e' : '#475569'}" />
        ${drawLadderWire(45, y0, 45, y0b, pState.pwr)}
        <circle cx="45" cy="${y0b}" r="2.5" fill="${pState.pwr ? '#22c55e' : '#475569'}" />

        <!-- S1 Start NO -->
        ${drawLadderWire(45, y0, 85 - 16, y0, pState.pwr)}
        ${drawLadderContactNO(85, y0, spec.in0, 'Start', pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(85 + 16, y0, 132, y0, hotTopOut)}

        <!-- K1 Seal-in NO -->
        ${drawLadderWire(45, y0b, 85 - 16, y0b, pState.pwr)}
        ${drawLadderContactNO(85, y0b, spec.mem0, 'Latch', pState.activeM0, pState.pwr, null)}
        ${drawLadderWire(85 + 16, y0b, 132, y0b, hotBotOut)}

        ${drawLadderWire(132, y0b, 132, y0, hotBotOut)}
        <circle cx="132" cy="${y0}" r="2.5" fill="${hotConverge ? '#22c55e' : '#475569'}" />

        <!-- S2 Stop NC -->
        ${drawLadderWire(132, y0, 192 - 16, y0, hotConverge)}
        ${drawLadderContactNC(192, y0, spec.in1, 'Stop', !pState.s2, hotConverge, 'S2')}
        ${drawLadderWire(192 + 16, y0, 295 - 16, y0, hotStopOut)}

        <!-- K1 Coil -->
        ${drawLadderCoil(295, y0, spec.mem0, 'K1', pState.activeM0, 'mem', hotStopOut)}
        ${drawLadderWire(295 + 16, y0, 358, y0, false)}

        <!-- Rung 1: Output Lamp L1 -->
        <text x="4" y="${y1 + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R1</text>
        ${drawLadderWire(22, y1, 110 - 16, y1, pState.pwr)}
        ${drawLadderContactNO(110, y1, spec.mem0, 'K1', pState.activeM0, pState.pwr, null)}
        ${drawLadderWire(110 + 16, y1, 295 - 16, y1, pState.pwr && pState.activeM0)}
        ${drawLadderCoil(295, y1, spec.out0, 'L1', pState.activeQ0, 'out', pState.pwr && pState.activeM0)}
        ${drawLadderWire(295 + 16, y1, 358, y1, false)}
      </svg>
    `;
  } else if (labId === 'lab4_1') {
    // 2 Rungs:
    // R0: PB1 NO -> Output 0 (PL1)
    // R1: PB1 NC -> Output 1 (PL2)
    const H = 155;
    const y0 = 42;
    const y1 = 112;
    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>

        <!-- Rung 0: PB1 NO -> Output 0 (PL1) -->
        <text x="4" y="${y0 + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R0</text>
        ${drawLadderWire(22, y0, 110 - 16, y0, pState.pwr)}
        ${drawLadderContactNO(110, y0, spec.in0, 'PB1', pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(110 + 16, y0, 295 - 16, y0, pState.pwr && pState.s1)}
        ${drawLadderCoil(295, y0, spec.out0, 'PL1', pState.activeQ0, 'out', pState.pwr && pState.s1)}
        ${drawLadderWire(295 + 16, y0, 358, y0, false)}

        <!-- Rung 1: PB1 NC -> Output 1 (PL2) -->
        <text x="4" y="${y1 + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R1</text>
        ${drawLadderWire(22, y1, 110 - 16, y1, pState.pwr)}
        ${drawLadderContactNC(110, y1, spec.in0, 'PB1', !pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(110 + 16, y1, 295 - 16, y1, pState.pwr && !pState.s1)}
        ${drawLadderCoil(295, y1, spec.out1, 'PL2', pState.activeQ1, 'out', pState.pwr && !pState.s1)}
        ${drawLadderWire(295 + 16, y1, 358, y1, false)}
      </svg>
    `;
  } else if (labId === 'lab4_2') {
    // 1 Rung: S1 NO AND S2 NO -> Output 0
    const H = 88;
    const y = 44;
    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>

        <text x="4" y="47" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R0</text>
        ${drawLadderWire(22, y, 90 - 16, y, pState.pwr)}
        ${drawLadderContactNO(90, y, spec.in0, 'S1', pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(90 + 16, y, 180 - 16, y, pState.pwr && pState.s1)}
        ${drawLadderContactNO(180, y, spec.in1, 'S2', pState.s2, pState.pwr && pState.s1, 'S2')}
        ${drawLadderWire(180 + 16, y, 295 - 16, y, pState.pwr && pState.s1 && pState.s2)}
        ${drawLadderCoil(295, y, spec.out0, 'PL1', pState.activeQ0, 'out', pState.pwr && pState.s1 && pState.s2)}
        ${drawLadderWire(295 + 16, y, 358, y, false)}
      </svg>
    `;
  } else if (labId === 'lab5_1') {
    // 1 Rung: PB1 NO -> Output 0 (PL1)
    const H = 88;
    const y = 44;
    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>

        <text x="4" y="47" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R0</text>
        ${drawLadderWire(22, y, 110 - 16, y, pState.pwr)}
        ${drawLadderContactNO(110, y, spec.in0, 'PB1', pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(110 + 16, y, 295 - 16, y, pState.pwr && pState.s1)}
        ${drawLadderCoil(295, y, spec.out0, 'PL1', pState.activeQ0, 'out', pState.pwr && pState.s1)}
        ${drawLadderWire(295 + 16, y, 358, y, false)}
      </svg>
    `;
  } else if (labId === 'lab5_2') {
    // 2 Rungs:
    // R0: PB1 NC -> %Q0.0 (PL1 แดงติดเมื่อไม่กด)
    // R1: PB1 NO -> %Q0.1 (PL2 เขียวติดเมื่อกด)
    const H = 155;
    const y0 = 42;
    const y1 = 112;
    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>

        <!-- Rung 0: PB1 NC (ปล่อย) -> PL1 แดง -->
        <text x="4" y="${y0 + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R0</text>
        ${drawLadderWire(22, y0, 110 - 16, y0, pState.pwr)}
        ${drawLadderContactNC(110, y0, spec.in0, 'PB1', !pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(110 + 16, y0, 295 - 16, y0, pState.pwr && !pState.s1)}
        ${drawLadderCoil(295, y0, spec.out0, 'PL1(แดง)', pState.activeQ0, 'out', pState.pwr && !pState.s1)}
        ${drawLadderWire(295 + 16, y0, 358, y0, false)}

        <!-- Rung 1: PB1 NO (กด) -> PL2 เขียว -->
        <text x="4" y="${y1 + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R1</text>
        ${drawLadderWire(22, y1, 110 - 16, y1, pState.pwr)}
        ${drawLadderContactNO(110, y1, spec.in0, 'PB1', pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(110 + 16, y1, 295 - 16, y1, pState.pwr && pState.s1)}
        ${drawLadderCoil(295, y1, spec.out1, 'PL2(เขียว)', pState.activeQ1, 'out', pState.pwr && pState.s1)}
        ${drawLadderWire(295 + 16, y1, 358, y1, false)}
      </svg>
    `;
  } else if (pState.lab && pState.lab.customSchematic) {
    // Dynamic Custom Schematic Ladder Diagram
    const branches = pState.lab.customSchematic.branches || [];
    const activeBranches = [];
    branches.forEach((b, idx) => {
      if (b && (b.topSlot || b.midSlot || b.loadSlot)) {
        activeBranches.push({ branch: b, index: idx });
      }
    });

    const count = Math.max(1, activeBranches.length);
    const H = count * 66 + 32;

    const compClosed = (comp) => {
      if (!comp) return false;
      if (comp === 'WIRE_V') return true;
      if (comp === 'S1_NO') return Boolean(pState.s1);
      if (comp === 'S1_NC') return !pState.s1;
      if (comp === 'S2_NO') return Boolean(pState.s2);
      if (comp === 'S2_NC') return !pState.s2;
      if (comp === 'K1_NO') return Boolean(pState.activeM0);
      if (comp === 'K1_NC') return !pState.activeM0;
      return false;
    };

    let rungsSvg = '';
    activeBranches.forEach((item, rIdx) => {
      const b = item.branch;
      const cy = 38 + rIdx * 66;

      const topClosed = compClosed(b.topSlot);
      const midClosed = compClosed(b.midSlot);
      const hotTopIn = pState.pwr;
      const hotTopOut = hotTopIn && (b.topSlot ? topClosed : true);
      const hotMidIn = hotTopOut;
      const hotMidOut = hotMidIn && (b.midSlot ? midClosed : true);

      let slot1Svg = '';
      if (b.topSlot === 'WIRE_V') {
        slot1Svg = drawLadderWire(90 - 16, cy, 90 + 16, cy, hotTopIn);
      } else if (b.topSlot === 'S1_NO') {
        slot1Svg = drawLadderContactNO(90, cy, spec.in0, 'S1', pState.s1, hotTopIn, 'S1');
      } else if (b.topSlot === 'S1_NC') {
        slot1Svg = drawLadderContactNC(90, cy, spec.in0, 'S1', !pState.s1, hotTopIn, 'S1');
      } else if (b.topSlot === 'S2_NO') {
        slot1Svg = drawLadderContactNO(90, cy, spec.in1, 'S2', pState.s2, hotTopIn, 'S2');
      } else if (b.topSlot === 'S2_NC') {
        slot1Svg = drawLadderContactNC(90, cy, spec.in1, 'S2', !pState.s2, hotTopIn, 'S2');
      } else if (b.topSlot === 'K1_NO') {
        slot1Svg = drawLadderContactNO(90, cy, spec.mem0, 'K1', pState.activeM0, hotTopIn, null);
      } else if (b.topSlot === 'K1_NC') {
        slot1Svg = drawLadderContactNC(90, cy, spec.mem0, 'K1', !pState.activeM0, hotTopIn, null);
      } else {
        slot1Svg = drawLadderWire(90 - 16, cy, 90 + 16, cy, hotTopIn);
      }

      let slot2Svg = '';
      if (b.midSlot === 'WIRE_V') {
        slot2Svg = drawLadderWire(180 - 16, cy, 180 + 16, cy, hotMidIn);
      } else if (b.midSlot === 'S1_NO') {
        slot2Svg = drawLadderContactNO(180, cy, spec.in0, 'S1', pState.s1, hotMidIn, 'S1');
      } else if (b.midSlot === 'S1_NC') {
        slot2Svg = drawLadderContactNC(180, cy, spec.in0, 'S1', !pState.s1, hotMidIn, 'S1');
      } else if (b.midSlot === 'S2_NO') {
        slot2Svg = drawLadderContactNO(180, cy, spec.in1, 'S2', pState.s2, hotMidIn, 'S2');
      } else if (b.midSlot === 'S2_NC') {
        slot2Svg = drawLadderContactNC(180, cy, spec.in1, 'S2', !pState.s2, hotMidIn, 'S2');
      } else if (b.midSlot === 'K1_NO') {
        slot2Svg = drawLadderContactNO(180, cy, spec.mem0, 'K1', pState.activeM0, hotMidIn, null);
      } else if (b.midSlot === 'K1_NC') {
        slot2Svg = drawLadderContactNC(180, cy, spec.mem0, 'K1', !pState.activeM0, hotMidIn, null);
      } else {
        slot2Svg = drawLadderWire(180 - 16, cy, 180 + 16, cy, hotMidIn);
      }

      let coilSvg = '';
      if (b.loadSlot === 'K1_COIL') {
        coilSvg = drawLadderCoil(295, cy, spec.mem0, 'K1', pState.activeM0, 'mem', hotMidOut);
      } else if (b.loadSlot === 'L1') {
        coilSvg = drawLadderCoil(295, cy, spec.out0, 'L1', pState.activeQ0, 'out', hotMidOut);
      } else if (b.loadSlot === 'L2') {
        coilSvg = drawLadderCoil(295, cy, spec.out1, 'L2', pState.activeQ1, 'out', hotMidOut);
      } else {
        coilSvg = drawLadderWire(295 - 16, cy, 295 + 16, cy, hotMidOut);
      }

      rungsSvg += `
        <text x="4" y="${cy + 3}" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R${rIdx}</text>
        ${drawLadderWire(22, cy, 90 - 16, cy, hotTopIn)}
        ${slot1Svg}
        ${drawLadderWire(90 + 16, cy, 180 - 16, cy, hotTopOut)}
        ${slot2Svg}
        ${drawLadderWire(180 + 16, cy, 295 - 16, cy, hotMidOut)}
        ${coilSvg}
        ${drawLadderWire(295 + 16, cy, 358, cy, false)}
      `;
    });

    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>
        ${rungsSvg}
      </svg>
    `;
  } else {
    // Default fallback simple rung
    const H = 88;
    const y = 44;
    svgContent = `
      <svg viewBox="0 0 380 ${H}" class="plc-ladder-svg">
        <line x1="22" y1="12" x2="22" y2="${H - 12}" stroke="#38bdf8" stroke-width="2.5" />
        <text x="22" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#38bdf8" text-anchor="middle">+24V</text>
        <line x1="358" y1="12" x2="358" y2="${H - 12}" stroke="#64748b" stroke-width="2.5" />
        <text x="358" y="10" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#94a3b8" text-anchor="middle">0V</text>
        <text x="4" y="47" font-family="'JetBrains Mono', monospace" font-size="8.5" fill="#64748b">R0</text>
        ${drawLadderWire(22, y, 110 - 16, y, pState.pwr)}
        ${drawLadderContactNO(110, y, spec.in0, 'S1', pState.s1, pState.pwr, 'S1')}
        ${drawLadderWire(110 + 16, y, 295 - 16, y, pState.pwr && pState.s1)}
        ${drawLadderCoil(295, y, spec.out0, 'L1', pState.activeQ0, 'out', pState.pwr && pState.s1)}
        ${drawLadderWire(295 + 16, y, 358, y, false)}
      </svg>
    `;
  }

  if (svgContent && !svgContent.includes('Kru-Jirawat')) {
    const wmSvg = `
      <text x="180" y="140" text-anchor="middle" fill="#64748b" opacity="0.14" font-size="26" font-weight="900" transform="rotate(-18, 180, 140)" pointer-events="none">Kru-Jirawat</text>
      <text x="352" y="250" text-anchor="end" fill="#64748b" opacity="0.55" font-size="9.5" font-weight="700" pointer-events="none">Kru-Jirawat</text>
    `;
    svgContent = svgContent.replace('</svg>', `${wmSvg}</svg>`);
  }

  container.innerHTML = svgContent;

  const fsLadderClone = document.getElementById('fsLadderClone');
  if (fsLadderClone) {
    fsLadderClone.innerHTML = svgContent;
  }

  updatePlcAddressTable(pState);
  updateTm221HwStrip(pState);
  updatePlcIlCode(pState);
  updatePlcFooterStatus(pState);
}

// Synchronize and update all PLC Model UI elements (Schneider TM221CE16R vs Mitsubishi FX5U-32MR)
function updatePlcModelUI(model = state.plcModel) {
  state.plcModel = model;
  const spec = getPlcModelSpec(model);

  // Sync dropdowns
  const selPlc = document.getElementById('plcModelSelect');
  if (selPlc && selPlc.value !== model) selPlc.value = model;
  const selWb = document.getElementById('wbPlcModelSelect');
  if (selWb && selWb.value !== model) selWb.value = model;

  // Header & pills
  const cardTitle = document.getElementById('plcCardTitle');
  if (cardTitle) {
    cardTitle.textContent = `⚡ ซิมูเลชัน PLC ควบคู่ (${spec.shortName})`;
  }
  const pill = document.getElementById('plcModelPill');
  if (pill) {
    pill.textContent = spec.shortName;
  }
  const hwModelName = document.getElementById('plcHwModelName');
  if (hwModelName) {
    hwModelName.textContent = spec.fullName;
  }
  const addrTableTitle = document.getElementById('plcAddrTableTitle');
  if (addrTableTitle) {
    addrTableTitle.textContent = `📋 ตารางระบุตำแหน่งอินพุต / เอาต์พุต (Address Table) - ${spec.shortName}`;
  }
  const addrColHeader = document.getElementById('plcAddrColHeader');
  if (addrColHeader) {
    addrColHeader.textContent = `แอดเดรส (${spec.shortName})`;
  }

  // Update dynamic terminal labels on #plcTerminalBoard
  const inComLbl = document.getElementById('plcInLbl_2');
  if (inComLbl) inComLbl.textContent = spec.inCom;

  for (let i = 0; i <= 8; i++) {
    const lbl = document.getElementById(`plcInLbl_${i + 3}`);
    if (lbl) {
      lbl.textContent = spec.termInShort(i);
    }
  }

  const outColIndices = [3, 4, 5, 6, 8, 9, 10];
  outColIndices.forEach((colIdx, i) => {
    const lbl = document.getElementById(`plcOutLbl_${colIdx}`);
    if (lbl) {
      lbl.textContent = spec.termOutShort(i);
    }
  });

  // Update PLC Panel Monitor labels
  for (let i = 0; i <= 8; i++) {
    const lbl = document.getElementById(`plcMonInLbl_${i}`);
    if (lbl) lbl.textContent = spec.termInShort(i);
  }
  for (let i = 0; i <= 6; i++) {
    const lbl = document.getElementById(`plcMonOutLbl_${i}`);
    if (lbl) lbl.textContent = spec.termOutShort(i);
  }
  const hwBadge = document.getElementById('plcHwModelBadge');
  if (hwBadge) hwBadge.textContent = spec.shortName;

  // Re-render ladder, schematic, truth table, and timing diagram
  renderPlcLadderDiagram();
  if (typeof renderSchematic === 'function') {
    renderSchematic();
  }
  if (typeof renderTruthTable === 'function') {
    renderTruthTable();
  }
  if (typeof renderTimingDiagramCanvas === 'function') {
    renderTimingDiagramCanvas();
  }
}

function initPlcLadderCoSim() {
  const btnMode = document.getElementById('btnPlcModeToggle');
  if (btnMode) {
    btnMode.addEventListener('click', () => {
      plcState.syncWithActualWiring = !plcState.syncWithActualWiring;
      if (plcState.syncWithActualWiring) {
        btnMode.classList.remove('ideal-mode');
        btnMode.textContent = '🔗 โหมด: ซิงค์ตามชุดฝึกจริง';
      } else {
        btnMode.classList.add('ideal-mode');
        btnMode.textContent = '💡 โหมด: ลอจิก PLC อัตโนมัติ';
      }
      renderPlcLadderDiagram();
    });
  }

  const btnIl = document.getElementById('btnTogglePlcIl');
  const drawer = document.getElementById('plcIlDrawer');
  if (btnIl && drawer) {
    btnIl.addEventListener('click', () => {
      plcState.showIlDrawer = !plcState.showIlDrawer;
      drawer.hidden = !plcState.showIlDrawer;
      btnIl.classList.toggle('active', plcState.showIlDrawer);
      btnIl.textContent = plcState.showIlDrawer ? '✕ ซ่อนคำสั่ง IL' : '📋 ดูคำสั่ง IL';
    });
  }

  // PLC Model Selector synchronization
  const selPlc = document.getElementById('plcModelSelect');
  if (selPlc) {
    selPlc.addEventListener('change', (e) => {
      updatePlcModelUI(e.target.value);
    });
  }

  const selWb = document.getElementById('wbPlcModelSelect');
  if (selWb) {
    selWb.addEventListener('change', (e) => {
      updatePlcModelUI(e.target.value);
    });
  }

  // PLC Wiring Logic Selector synchronization
  const wbPlcLogicSelect = document.getElementById('wbPlcLogicSelect');
  if (wbPlcLogicSelect) {
    wbPlcLogicSelect.addEventListener('change', (e) => {
      state.plcWiringLogic = e.target.value;
      updatePlcLogicModeUI();
      updateSimulationUI();
    });
  }

  // Fuse Reset Button
  const btnResetFuse = document.getElementById('btnResetFuse');
  if (btnResetFuse) {
    btnResetFuse.addEventListener('click', () => {
      resetFuses();
    });
  }

  // Initial PLC Model UI update
  updatePlcModelUI(state.plcModel);

  // Handle switch click inside ladder SVG & hardware pills
  const handleLadderSwitchClick = (e) => {
    const hit = e.target.closest('[data-sw]');
    if (!hit) return;
    const sw = hit.getAttribute('data-sw');
    if (sw && state.switches && state.switches[sw]) {
      state.switches[sw].pressed = !state.switches[sw].pressed;
      updateSimulationUI();
    }
  };

  const ladderViewport = document.getElementById('ladderViewport');
  if (ladderViewport) {
    ladderViewport.addEventListener('click', handleLadderSwitchClick);
  }

  const fsLadderClone = document.getElementById('fsLadderClone');
  if (fsLadderClone) {
    fsLadderClone.addEventListener('click', handleLadderSwitchClick);
  }

  const inRow = document.getElementById('tm221InputsRow');
  if (inRow) {
    inRow.addEventListener('click', handleLadderSwitchClick);
  }

  // Mobile Fullscreen tabs (Schematic vs Ladder)
  const btnFsTabSchem = document.getElementById('btnFsTabSchem');
  const btnFsTabLadder = document.getElementById('btnFsTabLadder');
  const fsSchem = document.getElementById('fsSchematicClone');
  const fsLadder = document.getElementById('fsLadderClone');

  if (btnFsTabSchem && btnFsTabLadder && fsSchem && fsLadder) {
    btnFsTabSchem.addEventListener('click', () => {
      btnFsTabSchem.classList.add('active');
      btnFsTabLadder.classList.remove('active');
      fsSchem.hidden = false;
      fsLadder.hidden = true;
    });
    btnFsTabLadder.addEventListener('click', () => {
      btnFsTabLadder.classList.add('active');
      btnFsTabSchem.classList.remove('active');
      fsSchem.hidden = true;
      fsLadder.hidden = false;
    });
  }
}

// Initialize Application
window.addEventListener('DOMContentLoaded', () => {
  initWorkbenchComponents();
  initInteractions();
  initCustomLabManager();
  initTimingDiagram();
  initPlcLadderCoSim();
  loadLab('lab1_1');
});
