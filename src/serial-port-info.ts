export type SerialPortInfoLike = {
	usbVendorId?: unknown;
	usbProductId?: unknown;
	bluetoothServiceClassId?: unknown;
};

export type SerialPortLike = {
	path?: unknown;
	comName?: unknown;
	portName?: unknown;
	getInfo?: () => SerialPortInfoLike;
};

export type SerialPortDisplay = {
	label: string;
	source: "os" | "usb" | "bluetooth" | "generic";
};

function stringValue(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOsPortLabel(value: string) {
	const comMatch = value.match(/\bCOM\d+\b/i);
	return comMatch ? comMatch[0].toUpperCase() : value;
}

function formatUsbId(value: unknown) {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xffff) return null;
	return `0x${numeric.toString(16).padStart(4, "0").toUpperCase()}`;
}

export function describeSerialPort(port: SerialPortLike | null | undefined): SerialPortDisplay {
	for (const value of [port?.comName, port?.path, port?.portName]) {
		const label = stringValue(value);
		if (label) return { label: normalizeOsPortLabel(label), source: "os" };
	}

	let info: SerialPortInfoLike = {};
	try {
		info = port?.getInfo?.() || {};
	} catch {}

	const vendorId = formatUsbId(info.usbVendorId);
	const productId = formatUsbId(info.usbProductId);
	if (vendorId && productId) return { label: `USB ${vendorId}:${productId}`, source: "usb" };

	const bluetoothId = stringValue(info.bluetoothServiceClassId);
	if (bluetoothId) return { label: `Bluetooth ${bluetoothId}`, source: "bluetooth" };

	return { label: "Port connected", source: "generic" };
}
