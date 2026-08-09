/**
 * QMS standalone thermal printer:
 * - WebUSB (direct Epson/Star/etc.)
 * - Web Serial (COM / USB-serial adapters)
 * - Browser/system print dialog ONLY when user explicitly chooses System Print
 * Chrome/Edge desktop only.
 * Version: 20260809d — unified POS/QMS token layout + compact cut
 */
(function (global) {
  const USB_STORAGE_KEY = 'qmsThermalUsb';
  const SERIAL_STORAGE_KEY = 'qmsThermalSerial';
  const TRANSPORT_KEY = 'qmsThermalTransport';
  const BAUD_KEY = 'qmsThermalBaud';
  const MODE_KEY = 'qmsPrinterMode';
  const USB_CHUNK_SIZE = 4096;
  const BAUD_RATES = [9600, 19200, 38400, 57600, 115200];
  const USB_FILTERS = [
    { vendorId: 0x04b8 }, // Epson
    { vendorId: 0x0519 }, // Star
    { vendorId: 0x1504 }, // Bixolon
    { vendorId: 0x0fe6 }, // Generic 80mm
  ];

  let cachedTransport = null;
  let cachedUsbDevice = null;
  let cachedSerialPort = null;
  let lastErrorCode = null; // 'usb_blocked' | 'no_serial' | etc.

  function isWebUsbSupported() {
    return typeof navigator !== 'undefined' && !!navigator.usb;
  }

  function isWebSerialSupported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
  }

  function isThermalPrintingSupported() {
    return isWebUsbSupported() || isWebSerialSupported();
  }

  function getPrinterMode() {
    try {
      return sessionStorage.getItem(MODE_KEY) || 'direct';
    } catch (e) {
      return 'direct';
    }
  }

  function setPrinterMode(mode) {
    try {
      sessionStorage.setItem(MODE_KEY, mode);
    } catch (e) { /* ignore */ }
  }

  function isSystemPrinterMode() {
    return getPrinterMode() === 'system';
  }

  function resetCache() {
    cachedTransport = null;
    cachedUsbDevice = null;
    cachedSerialPort = null;
  }

  function getActiveTransport() {
    if (isSystemPrinterMode() && !cachedTransport) return 'system';
    return cachedTransport;
  }

  function getLastErrorCode() {
    return lastErrorCode;
  }

  function persistUsb(device) {
    try {
      sessionStorage.setItem(
        USB_STORAGE_KEY,
        JSON.stringify({ vendorId: device.vendorId, productId: device.productId })
      );
      sessionStorage.setItem(TRANSPORT_KEY, 'usb');
    } catch (e) { /* ignore */ }
  }

  function loadUsbInfo() {
    try {
      return JSON.parse(sessionStorage.getItem(USB_STORAGE_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function persistSerial(info) {
    try {
      sessionStorage.setItem(SERIAL_STORAGE_KEY, JSON.stringify(info));
      sessionStorage.setItem(TRANSPORT_KEY, 'serial');
    } catch (e) { /* ignore */ }
  }

  function loadSerialInfo() {
    try {
      return JSON.parse(sessionStorage.getItem(SERIAL_STORAGE_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function findBulkOutEndpoint(device) {
    const configuration = device.configuration;
    if (!configuration?.interfaces?.length) {
      throw new Error('Printer USB configuration not found');
    }
    for (const iface of configuration.interfaces) {
      for (const alternate of iface.alternates) {
        const outEndpoint = alternate.endpoints.find(
          (endpoint) => endpoint.direction === 'out' && endpoint.type === 'bulk'
        );
        if (outEndpoint) {
          return {
            interfaceNumber: iface.interfaceNumber,
            alternateSetting: alternate.alternateSetting,
            endpointNumber: outEndpoint.endpointNumber,
          };
        }
      }
    }
    throw new Error('Printer USB bulk output endpoint not found');
  }

  async function openUsbDevice(device) {
    if (!device.opened) await device.open();
    if (device.configuration == null) await device.selectConfiguration(1);
    return findBulkOutEndpoint(device);
  }

  async function countRealDevices() {
    let count = 0;
    if (isWebUsbSupported()) {
      try { count += (await navigator.usb.getDevices())?.length || 0; } catch (e) { /* ignore */ }
    }
    if (isWebSerialSupported()) {
      try { count += (await navigator.serial.getPorts())?.length || 0; } catch (e) { /* ignore */ }
    }
    return count;
  }

  async function restoreCachedPrinter() {
    if (cachedTransport === 'usb' && cachedUsbDevice) return cachedUsbDevice;
    if (cachedTransport === 'serial' && cachedSerialPort) return cachedSerialPort;

    const preferred = (() => {
      try { return sessionStorage.getItem(TRANSPORT_KEY); } catch (e) { return null; }
    })();

    const tryUsb = async () => {
      if (!isWebUsbSupported()) return null;
      const devices = await navigator.usb.getDevices();
      const info = loadUsbInfo();
      const device =
        (info && devices.find((d) => d.vendorId === info.vendorId && d.productId === info.productId)) ||
        devices[0];
      if (!device) return null;
      cachedTransport = 'usb';
      cachedUsbDevice = device;
      return device;
    };

    const trySerial = async () => {
      if (!isWebSerialSupported()) return null;
      const ports = await navigator.serial.getPorts();
      const info = loadSerialInfo();
      const port =
        (info &&
          ports.find((p) => {
            const pi = typeof p.getInfo === 'function' ? p.getInfo() : null;
            return pi && pi.usbVendorId === info.usbVendorId && pi.usbProductId === info.usbProductId;
          })) ||
        ports[0];
      if (!port) return null;
      cachedTransport = 'serial';
      cachedSerialPort = port;
      return port;
    };

    try {
      if (preferred === 'serial') {
        return (await trySerial()) || (await tryUsb());
      }
      return (await tryUsb()) || (await trySerial());
    } catch (e) {
      return null;
    }
  }

  /** Real USB/Serial devices only — system mode does NOT count as connected. */
  async function getGrantedPrinterCount() {
    return countRealDevices();
  }

  async function hasDirectPrinterPaired() {
    if (await restoreCachedPrinter()) return true;
    return (await countRealDevices()) > 0;
  }

  async function connectUsbPrinter() {
    if (!isWebUsbSupported()) {
      throw new Error('WebUSB not supported. Use Chrome or Edge on desktop.');
    }
    resetCache();
    setPrinterMode('direct');
    lastErrorCode = null;

    let device;
    try {
      // Prefer Epson first (TM-T88V = 0x04b8), then show all USB devices
      try {
        device = await navigator.usb.requestDevice({
          filters: [{ vendorId: 0x04b8 }, { vendorId: 0x0519 }, { vendorId: 0x1504 }],
        });
      } catch (e1) {
        if (e1?.name === 'NotFoundError') {
          device = await navigator.usb.requestDevice({ filters: [] });
        } else {
          throw e1;
        }
      }
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        lastErrorCode = 'usb_not_found';
        throw new Error('No USB printer selected. Select TM-T88V in the list.');
      }
      throw error;
    }
    if (!device) throw new Error('No USB printer selected');

    // MUST claim + write a real test — open-only can "succeed" while Windows still blocks printing
    try {
      const endpointInfo = await openUsbDevice(device);
      await device.claimInterface(endpointInfo.interfaceNumber);
      try {
        const test = new Uint8Array([0x1b, 0x40]); // ESC @ init
        const result = await device.transferOut(endpointInfo.endpointNumber, test);
        if (result.status !== 'ok') {
          throw new Error('USB transfer failed: ' + result.status);
        }
      } finally {
        try { await device.releaseInterface(endpointInfo.interfaceNumber); } catch (e) { /* ignore */ }
        try { if (device.opened) await device.close(); } catch (e) { /* ignore */ }
      }
    } catch (error) {
      try { if (device.opened) await device.close(); } catch (e) { /* ignore */ }
      if (
        error?.name === 'SecurityError' ||
        error?.name === 'NetworkError' ||
        /access|denied|claim|transfer|protected/i.test(error?.message || '')
      ) {
        lastErrorCode = 'usb_blocked';
        const blocked = new Error(
          'Windows is blocking Chrome from sending data to TM-T88V (USB Print driver). ' +
          'Serial/COM will stay empty for this printer. ' +
          'Fix for silent print: install WinUSB with Zadig (zadig.akeo.ie) on the Epson TM-T88V interface, unplug/replug USB, then click USB again and select TM-T88V. ' +
          'Until then only System Print works (Chrome dialog).'
        );
        blocked.code = 'usb_blocked';
        throw blocked;
      }
      throw error;
    }

    cachedTransport = 'usb';
    cachedUsbDevice = device;
    persistUsb(device);
    lastErrorCode = null;
    return { transport: 'usb', device, productName: device.productName || 'TM-T88V' };
  }

  async function connectSerialPrinter() {
    if (!isWebSerialSupported()) {
      throw new Error('Web Serial not supported. Use Chrome or Edge on desktop.');
    }
    resetCache();
    setPrinterMode('direct');
    lastErrorCode = null;

    let port;
    try {
      port = await navigator.serial.requestPort();
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        lastErrorCode = 'no_serial';
        throw new Error(
          'Serial/COM is empty — normal for Epson TM-T88V. This printer does not create a COM port. Use USB (with WinUSB/Zadig) for silent print, not Serial.'
        );
      } else if (error?.name === 'NotAllowedError') {
        throw new Error('Serial permission denied. Click Serial/COM again and allow access.');
      } else {
        throw error;
      }
    }
    if (!port) throw new Error('No serial printer port selected');

    cachedTransport = 'serial';
    cachedSerialPort = port;
    if (typeof port.getInfo === 'function') persistSerial(port.getInfo());
    lastErrorCode = null;
    return { transport: 'serial', port };
  }

  async function connectThermalPrinter() {
    const errors = [];
    if (isWebUsbSupported()) {
      try {
        return await connectUsbPrinter();
      } catch (error) {
        errors.push(error.message || 'USB failed');
        // If USB blocked, immediately try Serial (do not go to System Print)
        if (error.code === 'usb_blocked' || lastErrorCode === 'usb_blocked') {
          if (isWebSerialSupported()) {
            try {
              return await connectSerialPrinter();
            } catch (serialErr) {
              errors.push(serialErr.message || 'Serial failed');
              const combined = new Error(
                'USB blocked by Windows. Serial/COM also unavailable. Install WinUSB via Zadig for silent print, or click System Print (dialog).'
              );
              combined.code = 'usb_blocked';
              throw combined;
            }
          }
        }
      }
    }
    if (isWebSerialSupported()) {
      try {
        return await connectSerialPrinter();
      } catch (error) {
        errors.push(error.message || 'Serial/COM failed');
      }
    }
    throw new Error(errors.join(' ') || 'No printer connection available');
  }

  function connectSystemPrinter() {
    resetCache();
    setPrinterMode('system');
    lastErrorCode = null;
    return { transport: 'system' };
  }

  async function writeToUsbDevice(device, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const endpointInfo = await openUsbDevice(device);
    try {
      await device.claimInterface(endpointInfo.interfaceNumber);
      for (let offset = 0; offset < bytes.length; offset += USB_CHUNK_SIZE) {
        const chunk = bytes.slice(offset, offset + USB_CHUNK_SIZE);
        const result = await device.transferOut(endpointInfo.endpointNumber, chunk);
        if (result.status !== 'ok') throw new Error(`USB print transfer failed: ${result.status}`);
      }
    } finally {
      try { await device.releaseInterface(endpointInfo.interfaceNumber); } catch (e) { /* ignore */ }
      try { if (device.opened) await device.close(); } catch (e) { /* ignore */ }
    }
  }

  async function writeToSerialPort(port, data) {
    let preferred = [];
    try {
      const raw = sessionStorage.getItem(BAUD_KEY);
      if (raw) preferred = [parseInt(raw, 10)].filter((n) => Number.isFinite(n));
    } catch (e) { /* ignore */ }
    const rates = [...new Set([...preferred, ...BAUD_RATES])];

    let lastError;
    for (const baudRate of rates) {
      try {
        if (port.readable || port.writable) {
          try { await port.close(); } catch (e) { /* ignore */ }
        }
        await port.open({
          baudRate,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          flowControl: 'none',
        });
        const writer = port.writable.getWriter();
        try {
          await writer.write(data instanceof Uint8Array ? data : new Uint8Array(data));
        } finally {
          writer.releaseLock();
        }
        try { await port.close(); } catch (e) { /* ignore */ }
        try { sessionStorage.setItem(BAUD_KEY, String(baudRate)); } catch (e) { /* ignore */ }
        return baudRate;
      } catch (error) {
        lastError = error;
        try { await port.close(); } catch (e) { /* ignore */ }
      }
    }
    throw new Error(lastError?.message || 'Could not open serial/COM printer port');
  }

  async function writeToThermalPrinter(data) {
    // Prefer silent direct even if user previously chose system mode
    const restored = await restoreCachedPrinter();
    if (!restored) {
      throw new Error('Printer not connected. Click Serial/COM (recommended) or USB first.');
    }
    setPrinterMode('direct');

    if (cachedTransport === 'usb' && cachedUsbDevice) {
      try {
        await writeToUsbDevice(cachedUsbDevice, data);
        return 'usb';
      } catch (error) {
        if (error?.name === 'SecurityError' || /access|denied|claim/i.test(error?.message || '')) {
          lastErrorCode = 'usb_blocked';
          throw new Error(
            'USB blocked by Windows while printing. Click Serial/COM and select the printer, then print again.'
          );
        }
        throw error;
      }
    }
    if (cachedTransport === 'serial' && cachedSerialPort) {
      await writeToSerialPort(cachedSerialPort, data);
      return 'serial';
    }
    throw new Error('Printer not connected. Click USB or Serial/COM first.');
  }

  function esc(...bytes) {
    return bytes;
  }

  function line(str = '') {
    return [...new TextEncoder().encode(String(str)), 0x0a];
  }

  function boldOn() {
    return esc(0x1b, 0x45, 0x01);
  }

  function boldOff() {
    return esc(0x1b, 0x45, 0x00);
  }

  function charSize(n = 0) {
    return esc(0x1d, 0x21, n & 0xff);
  }

  function feed(n = 1) {
    return esc(0x1b, 0x64, Math.max(0, Math.min(255, n)));
  }

  function appendBytes(out, bytes) {
    if (!bytes || !bytes.length) return;
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
  }

  /** Five lines clear the cutter without leaving a long blank tail */
  function cutSafe() {
    return [
      0x0a, 0x0a, 0x0a, 0x0a, 0x0a,
      0x1d, 0x56, 0x00, // full cut
    ];
  }

  function canvasToEscPosRaster(canvas) {
    const srcW = canvas.width;
    const srcH = canvas.height;
    const w = Math.floor(srcW / 8) * 8;
    const h = srcH;
    if (w < 8 || h < 1) return null;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, srcW, srcH);

    // Sample center of logo (not corners — white letterbox can fool detection)
    const mid = (x, y) => {
      const i = (Math.min(srcH - 1, Math.max(0, y)) * srcW + Math.min(srcW - 1, Math.max(0, x))) * 4;
      return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    };
    const bgSample =
      (mid(4, 4) + mid(srcW - 5, 4) + mid(4, srcH - 5) + mid(srcW - 5, srcH - 5) + mid((srcW / 2) | 0, 4)) / 5;
    // petzonelogo.png has black background
    const darkBackground = bgSample < 90;

    const bytesPerRow = w / 8;
    const raster = new Uint8Array(bytesPerRow * h);
    let blackCount = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * srcW + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 40) continue;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        let ink = false;
        if (darkBackground) {
          // Skip near-black background; print colored / light artwork
          ink = !(r < 40 && g < 40 && b < 40) && lum > 20;
        } else {
          ink = !(r > 245 && g > 245 && b > 245) && lum < 200;
        }
        if (ink) {
          raster[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
          blackCount += 1;
        }
      }
    }
    if (blackCount < 30) return null;

    const header = new Uint8Array([
      0x1d, 0x76, 0x30, 0x00,
      bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
      h & 0xff, (h >> 8) & 0xff,
    ]);
    const out = new Uint8Array(header.length + raster.length);
    out.set(header, 0);
    out.set(raster, header.length);
    return out;
  }

  async function loadLogoBitmap(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error('logo http ' + res.status);
    const blob = await res.blob();
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob);
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Real PetZone PNG only — never the pink-circle SVG placeholder.
   * Fetches /assets/petzonelogo.png (same file the kiosk <img> shows).
   */
  async function logoToEscPosRaster(maxWidthDots = 320) {
    if (typeof window === 'undefined') return null;
    const candidates = [
      '/assets/petzonelogo.png?v=20260805b',
      '/assets/petzonelogo.png',
      '/petzonelogo.png?v=20260805b',
    ];

    for (const path of candidates) {
      try {
        const img = await loadLogoBitmap(path);
        let w = img.width || img.naturalWidth;
        let h = img.height || img.naturalHeight;
        if (!w || !h) {
          if (img.close) img.close();
          continue;
        }

        const targetW = Math.min(maxWidthDots, 360);
        if (w > targetW) {
          h = Math.round((h * targetW) / w);
          w = targetW;
        }
        if (h > 88) {
          w = Math.floor((w * 88) / h / 8) * 8;
          h = 88;
        }
        w = Math.floor(w / 8) * 8;
        if (w < 8) {
          if (img.close) img.close();
          continue;
        }

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, 0, 0, w, h);
        if (img.close) img.close();

        const raster = canvasToEscPosRaster(canvas);
        if (raster) return raster;
      } catch (e) {
        console.warn('QMS logo load failed:', path, e);
      }
    }
    console.warn('QMS: petzonelogo.png could not be rasterized for thermal print');
    return null;
  }

  async function buildTokenEscPos({
    ticketCode,
    serviceName,
    branchName,
    waitingAhead,
    issuedAt,
    petName,
  }) {
    const out = [];
    out.push(...esc(0x1b, 0x40));
    out.push(...esc(0x1b, 0x61, 0x01));

    try {
      const logo = await logoToEscPosRaster(320);
      if (logo) appendBytes(out, logo);
    } catch (e) {
      console.warn('QMS logo print skipped:', e);
    }

    out.push(...esc(0x1b, 0x4d, 0x00)); // Font A
    out.push(...esc(0x1b, 0x21, 0x18)); // bold + double height
    out.push(...line('PetZone'));
    out.push(...esc(0x1b, 0x21, 0x00));

    if (serviceName) {
      out.push(...boldOn());
      out.push(...line(String(serviceName).slice(0, 42)));
      out.push(...boldOff());
    }

    out.push(...feed(1));
    out.push(...esc(0x1d, 0x21, 0x33)); // 4× width and height
    out.push(...boldOn());
    out.push(...line(String(ticketCode || '---')));
    out.push(...boldOff());
    out.push(...esc(0x1d, 0x21, 0x00));
    out.push(...feed(1));
    out.push(...esc(0x1b, 0x4d, 0x01)); // compact details

    if (branchName) out.push(...line(String(branchName).slice(0, 48)));
    if (petName) out.push(...line(`Pet: ${String(petName).slice(0, 42)}`));

    const ahead = Number(waitingAhead);
    if (Number.isFinite(ahead) && ahead > 0) {
      out.push(...line(`${ahead} patient(s) ahead of you`));
    } else if (Number.isFinite(ahead) && ahead === 0) {
      out.push(...line('You are next in queue!'));
    }

    const when = issuedAt ? new Date(issuedAt) : new Date();
    out.push(...line(when.toLocaleString()));
    out.push(...line('Please wait for your number to be called'));
    out.push(...line('Powered by Tychora'));
    out.push(...esc(0x1b, 0x4d, 0x00));
    appendBytes(out, cutSafe());
    return new Uint8Array(out);
  }

  function printTokenBrowser() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok, message) => {
        if (settled) return;
        settled = true;
        resolve({ success: ok, method: 'browser', message });
      };
      const after = () => {
        window.removeEventListener('afterprint', after);
        finish(true, 'Chrome print dialog opened — choose Epson');
      };
      window.addEventListener('afterprint', after);
      try {
        window.print();
      } catch (e) {
        window.removeEventListener('afterprint', after);
        finish(false, e.message);
        return;
      }
      setTimeout(() => {
        window.removeEventListener('afterprint', after);
        finish(true, 'Chrome print dialog opened — choose Epson');
      }, 4000);
    });
  }

  /**
   * Silent USB ESC/POS only. Chrome print dialog ONLY if preferBrowser=true (System Print button).
   */
  async function printQueueTicket(ticket, { preferBrowser = false, allowConnectPrompt = false } = {}) {
    const payload = await buildTokenEscPos({
      ticketCode: ticket.ticket_code || ticket.ticket_number,
      serviceName: ticket.service_name,
      branchName: ticket.branch_name,
      waitingAhead: ticket.waiting_ahead,
      issuedAt: ticket.issued_at,
      petName: ticket.pet_name,
    });

    // Explicit System Print path only
    if (preferBrowser) {
      return printTokenBrowser();
    }

    // Never use window.print() below this line
    setPrinterMode('direct');

    if (!isThermalPrintingSupported()) {
      return {
        success: false,
        method: 'none',
        message: 'Use Chrome/Edge on desktop. Connect USB and select TM-T88V for silent print.',
      };
    }

    try {
      let restored = await restoreCachedPrinter();
      if (!restored && allowConnectPrompt) {
        await connectUsbPrinter();
        restored = true;
      }
      if (!restored) {
        // Try previously paired USB devices without showing picker
        if (isWebUsbSupported()) {
          const devices = await navigator.usb.getDevices();
          if (devices.length) {
            cachedTransport = 'usb';
            cachedUsbDevice = devices[0];
            persistUsb(devices[0]);
            restored = true;
          }
        }
      }
      if (!restored) {
        return {
          success: false,
          method: 'none',
          code: 'not_connected',
          message:
            'Printer not connected. Click USB once, select TM-T88V, then Get My Number. Do not use System Print if you want no dialog.',
        };
      }

      const transport = await writeToThermalPrinter(payload);
      const via = transport === 'serial' ? 'serial/COM' : 'USB';
      return {
        success: true,
        method: transport,
        message: `Token printed via ${via} (no dialog)`,
      };
    } catch (err) {
      resetCache();
      lastErrorCode = err.code || lastErrorCode || 'print_failed';
      return {
        success: false,
        method: 'none',
        code: lastErrorCode,
        message:
          err.message ||
          'Silent USB print failed. Windows is blocking the printer — install WinUSB with Zadig for TM-T88V, then click USB again.',
      };
    }
  }

  function getPrinterSupportMessage() {
    if (lastErrorCode === 'usb_blocked') {
      return 'Windows blocks USB print. Install WinUSB (Zadig) for TM-T88V, then click USB and select TM-T88V. Serial stays empty for this printer.';
    }
    if (lastErrorCode === 'no_serial') {
      return 'Serial/COM is empty for TM-T88V — use USB instead (with WinUSB if needed).';
    }
    if (isSystemPrinterMode()) {
      return 'System Print = Chrome dialog every time. Click USB + TM-T88V for silent print.';
    }
    if (!isThermalPrintingSupported()) {
      return 'Use Chrome or Edge on a laptop/desktop.';
    }
    return 'Click USB → select TM-T88V once. After that, Get My Number prints silently (no Chrome dialog).';
  }

  global.QmsThermal = {
    isThermalPrintingSupported,
    isWebUsbSupported,
    isWebSerialSupported,
    isSystemPrinterMode,
    getGrantedPrinterCount,
    hasDirectPrinterPaired,
    getActiveTransport,
    getLastErrorCode,
    connectUsbPrinter,
    connectSerialPrinter,
    connectThermalPrinter,
    connectSystemPrinter,
    restoreCachedPrinter,
    printQueueTicket,
    printTokenBrowser,
    getPrinterSupportMessage,
    resetCache,
    setPrinterMode,
  };
})(window);
