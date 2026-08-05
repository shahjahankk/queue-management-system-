/**
 * QMS standalone thermal printer:
 * - WebUSB (direct Epson/Star/etc.)
 * - Web Serial (COM / USB-serial adapters)
 * - Browser/system print dialog ONLY when user explicitly chooses System Print
 * Chrome/Edge desktop only.
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
      device = await navigator.usb.requestDevice({ filters: [] });
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        lastErrorCode = 'usb_not_found';
        throw new Error('No USB device selected. Click Serial/COM if Epson is not listed under USB.');
      }
      throw error;
    }
    if (!device) throw new Error('No USB printer selected');

    try {
      const endpointInfo = await openUsbDevice(device);
      try {
        await device.releaseInterface(endpointInfo.interfaceNumber);
        await device.close();
      } catch (e) { /* ignore */ }
    } catch (error) {
      try { if (device.opened) await device.close(); } catch (e) { /* ignore */ }
      if (error?.name === 'SecurityError' || /access|denied|claim/i.test(error?.message || '')) {
        lastErrorCode = 'usb_blocked';
        const blocked = new Error(
          'USB blocked by Windows driver. Click Serial/COM next. If Epson is not there, install WinUSB with Zadig (zadig.akeo.ie) for silent print.'
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
    return { transport: 'usb', device };
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
      // Unfiltered first so all COM / USB-serial adapters appear
      port = await navigator.serial.requestPort();
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        try {
          port = await navigator.serial.requestPort({
            filters: USB_FILTERS.map((f) => ({ usbVendorId: f.vendorId })),
          });
        } catch (e2) {
          lastErrorCode = 'no_serial';
          throw new Error(
            'No Serial/COM port found. Epson often has no COM port when Windows USB Print owns it. Install WinUSB via Zadig, or use System Print (shows Chrome dialog).'
          );
        }
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
    return [...new TextEncoder().encode(str), 0x0a];
  }

  function buildTokenEscPos({ ticketCode, serviceName, branchName }) {
    return new Uint8Array([
      ...esc(0x1b, 0x40),
      ...esc(0x1b, 0x61, 0x01),
      ...esc(0x1b, 0x21, 0x30),
      ...line('PetZone'),
      ...esc(0x1b, 0x21, 0x00),
      ...line(serviceName || 'Consultancy'),
      ...line(''),
      ...esc(0x1b, 0x21, 0x38),
      ...line(String(ticketCode || '---')),
      ...esc(0x1b, 0x21, 0x00),
      ...line(''),
      ...line(branchName || ''),
      ...line(new Date().toLocaleString()),
      ...line(''),
      ...line('Please wait to be called'),
      ...line(''),
      ...line(''),
      ...esc(0x1d, 0x56, 0x00),
    ]);
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
   * Silent USB/Serial by default. Browser dialog ONLY when preferBrowser=true
   * and no direct printer is paired.
   */
  async function printQueueTicket(ticket, { preferBrowser = false, allowConnectPrompt = false } = {}) {
    const payload = buildTokenEscPos({
      ticketCode: ticket.ticket_code || ticket.ticket_number,
      serviceName: ticket.service_name,
      branchName: ticket.branch_name,
    });

    // Always try silent direct first if a device is paired
    if (isThermalPrintingSupported()) {
      try {
        let restored = await restoreCachedPrinter();
        if (!restored && allowConnectPrompt) {
          // Prefer Serial when USB was previously blocked
          if (lastErrorCode === 'usb_blocked' && isWebSerialSupported()) {
            await connectSerialPrinter();
          } else {
            await connectThermalPrinter();
          }
          restored = true;
        }
        if (restored || (await hasDirectPrinterPaired())) {
          const transport = await writeToThermalPrinter(payload);
          const via = transport === 'serial' ? 'serial/COM' : 'USB';
          return {
            success: true,
            method: transport,
            message: `Token printed via ${via} (no dialog)`,
          };
        }
      } catch (err) {
        resetCache();
        console.warn('Silent thermal print failed:', err);
        if (!preferBrowser) {
          return {
            success: false,
            method: 'none',
            code: lastErrorCode || err.code || 'print_failed',
            message:
              err.message ||
              'Silent print failed. Click Serial/COM (USB is blocked on Windows), then try again.',
          };
        }
      }
    }

    if (preferBrowser) {
      return printTokenBrowser();
    }

    return {
      success: false,
      method: 'none',
      code: lastErrorCode || 'not_connected',
      message:
        'Printer not connected for silent print. Click Serial/COM (recommended after USB block), or USB. System Print always shows a Chrome dialog.',
    };
  }

  function getPrinterSupportMessage() {
    if (lastErrorCode === 'usb_blocked') {
      return 'USB blocked by Windows. Click Serial/COM now for silent print.';
    }
    if (isSystemPrinterMode()) {
      return 'System Print = Chrome dialog (not silent). Prefer Serial/COM or USB.';
    }
    if (!isThermalPrintingSupported()) {
      return 'Use Chrome or Edge on a laptop/desktop.';
    }
    return 'Connect Serial/COM or USB for silent token print (no Chrome dialog).';
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
