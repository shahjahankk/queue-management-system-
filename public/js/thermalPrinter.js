/**
 * QMS standalone thermal printer:
 * - WebUSB (direct Epson/Star/etc.)
 * - Web Serial (COM / USB-serial adapters)
 * - Browser/system print dialog fallback
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
    if (isSystemPrinterMode()) return 'system';
    return cachedTransport;
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

  async function restoreCachedPrinter() {
    if (isSystemPrinterMode()) return null;
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

  async function getGrantedPrinterCount() {
    if (isSystemPrinterMode()) return 1;
    let count = 0;
    if (isWebUsbSupported()) {
      try { count += (await navigator.usb.getDevices())?.length || 0; } catch (e) { /* ignore */ }
    }
    if (isWebSerialSupported()) {
      try { count += (await navigator.serial.getPorts())?.length || 0; } catch (e) { /* ignore */ }
    }
    return count;
  }

  async function connectUsbPrinter() {
    if (!isWebUsbSupported()) {
      throw new Error('WebUSB not supported. Use Chrome or Edge on desktop.');
    }
    resetCache();
    setPrinterMode('direct');
    const device = await navigator.usb.requestDevice({ filters: [] });
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
        throw new Error(
          'USB printer blocked by Windows driver. Use Serial/COM instead, or install WinUSB via Zadig for the Epson.'
        );
      }
      throw error;
    }

    cachedTransport = 'usb';
    cachedUsbDevice = device;
    persistUsb(device);
    return { transport: 'usb', device };
  }

  async function connectSerialPrinter() {
    if (!isWebSerialSupported()) {
      throw new Error('Web Serial not supported. Use Chrome or Edge on desktop.');
    }
    resetCache();
    setPrinterMode('direct');

    let port;
    try {
      port = await navigator.serial.requestPort({
        filters: USB_FILTERS.map((f) => ({ usbVendorId: f.vendorId })),
      });
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        port = await navigator.serial.requestPort();
      } else {
        throw error;
      }
    }
    if (!port) throw new Error('No serial/COM port selected');

    cachedTransport = 'serial';
    cachedSerialPort = port;
    if (typeof port.getInfo === 'function') persistSerial(port.getInfo());
    return { transport: 'serial', port };
  }

  async function connectThermalPrinter() {
    const errors = [];
    if (isWebUsbSupported()) {
      try {
        return await connectUsbPrinter();
      } catch (error) {
        if (error?.name !== 'NotAllowedError') errors.push(error.message || 'USB failed');
        else errors.push('USB permission denied');
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
    if (isSystemPrinterMode()) {
      throw new Error('System printer mode — use browser print');
    }
    await restoreCachedPrinter();
    if (cachedTransport === 'usb' && cachedUsbDevice) {
      await writeToUsbDevice(cachedUsbDevice, data);
      return 'usb';
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
        finish(true, 'Sent to system printer');
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
        finish(true, 'Sent to system printer');
      }, 4000);
    });
  }

  async function printQueueTicket(ticket, { preferBrowser = false, allowConnectPrompt = false } = {}) {
    if (preferBrowser || isSystemPrinterMode()) {
      return printTokenBrowser();
    }

    if (isThermalPrintingSupported()) {
      try {
        let restored = await restoreCachedPrinter();
        if (!restored && allowConnectPrompt) {
          await connectThermalPrinter();
          restored = true;
        }
        if (restored) {
          const transport = await writeToThermalPrinter(
            buildTokenEscPos({
              ticketCode: ticket.ticket_code || ticket.ticket_number,
              serviceName: ticket.service_name,
              branchName: ticket.branch_name,
            })
          );
          const via = transport === 'serial' ? 'serial/COM' : 'USB';
          return {
            success: true,
            method: transport,
            message: `Printed via ${via}`,
          };
        }
      } catch (err) {
        resetCache();
        console.warn('Thermal print failed, falling back to browser:', err);
      }
    }

    const browser = await printTokenBrowser();
    return {
      success: browser.success,
      method: 'browser',
      message: browser.success
        ? 'Print dialog opened — choose your Epson thermal printer'
        : browser.message || 'Print failed',
    };
  }

  function getPrinterSupportMessage() {
    if (isSystemPrinterMode()) {
      return 'System/browser print mode — choose Epson in the print dialog.';
    }
    if (!isThermalPrintingSupported()) {
      return 'Use Chrome or Edge on a laptop/desktop. Phones/Safari cannot use USB or serial printers.';
    }
    return 'Use USB for direct Epson, Serial/COM for COM ports or USB-serial adapters, or System Print for the OS dialog.';
  }

  global.QmsThermal = {
    isThermalPrintingSupported,
    isWebUsbSupported,
    isWebSerialSupported,
    isSystemPrinterMode,
    getGrantedPrinterCount,
    getActiveTransport,
    connectUsbPrinter,
    connectSerialPrinter,
    connectThermalPrinter,
    connectSystemPrinter,
    restoreCachedPrinter,
    printQueueTicket,
    printTokenBrowser,
    getPrinterSupportMessage,
    resetCache,
  };
})(window);
