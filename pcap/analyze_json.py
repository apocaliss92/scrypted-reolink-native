#!/usr/bin/env python3
"""
Analyze Wireshark JSON exports to compare neolink vs scrypted UDP flows.
"""
import json
import sys
import struct
from typing import List, Dict, Any

BCUDP_MAGIC_DISCOVERY = 0x3acf872a
BCUDP_MAGIC_DATA = 0x10cf872a
BCUDP_MAGIC_ACK = 0x20cf872a

def hex_to_bytes(hex_str: str) -> bytes:
    """Convert hex string (e.g., '10:cf:87:2a') to bytes."""
    try:
        return bytes.fromhex(hex_str.replace(':', '').replace(' ', ''))
    except:
        return b''

def parse_bcudp_packet(udp_data_hex: str) -> Dict[str, Any] | None:
    """Parse BCUDP packet from hex string."""
    try:
        data = hex_to_bytes(udp_data_hex)
        if len(data) < 4:
            return None
        
        # Wireshark exports hex strings in the order they appear in the packet
        # BCUDP magic numbers are stored as little-endian in the packet
        # But when we convert hex string to bytes, we get the bytes in order
        # So 3a:cf:87:2a becomes bytes [0x3a, 0xcf, 0x87, 0x2a]
        # Reading as little-endian: 0x2a87cf3a (wrong)
        # Reading as big-endian: 0x3acf872a (correct!)
        # Actually wait - let me check the actual byte order in the hex string
        # The hex shows "3a:cf:87:2a" which as bytes is [0x3a, 0xcf, 0x87, 0x2a]
        # As little-endian uint32: 0x2a87cf3a
        # As big-endian uint32: 0x3acf872a
        # So we need big-endian for the magic comparison
        magic = struct.unpack('>I', data[0:4])[0]
        
        if magic == BCUDP_MAGIC_DISCOVERY:
            return {'type': 'discovery', 'magic': hex(magic), 'payload': udp_data_hex}
        elif magic == BCUDP_MAGIC_DATA:
            if len(data) < 20:
                return None
            connection_id = int.from_bytes(data[4:8], 'little', signed=True)
            packet_id = int.from_bytes(data[12:16], 'little')
            payload_len = int.from_bytes(data[16:20], 'little')
            return {
                'type': 'data',
                'magic': hex(magic),
                'connection_id': connection_id,
                'packet_id': packet_id,
                'payload_len': payload_len,
                'payload_hex': udp_data_hex[:80]  # First 40 bytes hex
            }
        elif magic == BCUDP_MAGIC_ACK:
            if len(data) < 28:
                return None
            connection_id = int.from_bytes(data[4:8], 'little', signed=True)
            group_id = int.from_bytes(data[12:16], 'little')
            packet_id = int.from_bytes(data[16:20], 'little')
            return {
                'type': 'ack',
                'magic': hex(magic),
                'connection_id': connection_id,
                'group_id': group_id,
                'packet_id': packet_id,
                'payload_hex': udp_data_hex[:56]  # First 28 bytes hex
            }
    except Exception as e:
        return None
    
    return None

def extract_packets(json_file: str) -> List[Dict[str, Any]]:
    """Extract BCUDP packets from Wireshark JSON export."""
    packets = []
    
    with open(json_file, 'r') as f:
        data = json.load(f)
    
    for entry in data:
        source = entry.get('_source', {})
        layers = source.get('layers', {})
        
        # Get frame info
        frame = layers.get('frame', {})
        frame_num = int(frame.get('frame.number', '0'))
        frame_time = float(frame.get('frame.time_relative', '0'))
        
        # Get UDP info
        udp = layers.get('udp', {})
        if not udp:
            continue
        
        src_port = int(udp.get('udp.srcport', '0'))
        dst_port = int(udp.get('udp.dstport', '0'))
        
        # Get UDP data (from udp.payload field)
        udp_data_hex = udp.get('udp.payload', '')
        if not udp_data_hex:
            continue
        
        # Get IP addresses to determine direction
        ip = layers.get('ip', {})
        src_ip = ip.get('ip.src', '')
        dst_ip = ip.get('ip.dst', '')
        
        # Parse BCUDP packet
        bcudp = parse_bcudp_packet(udp_data_hex)
        if bcudp:
            packets.append({
                'frame_num': frame_num,
                'time': frame_time,
                'src_ip': src_ip,
                'dst_ip': dst_ip,
                'src_port': src_port,
                'dst_port': dst_port,
                'bcudp': bcudp
            })
    
    return packets

def print_flow_summary(packets: List[Dict[str, Any]], name: str, limit: int = 100):
    """Print summary of packet flow."""
    print(f"\n{'='*100}")
    print(f"{name}: {len(packets)} BCUDP packets")
    print(f"{'='*100}")
    
    # Count by type
    discovery_count = sum(1 for p in packets if p['bcudp']['type'] == 'discovery')
    data_count = sum(1 for p in packets if p['bcudp']['type'] == 'data')
    ack_count = sum(1 for p in packets if p['bcudp']['type'] == 'ack')
    
    print(f"\nCounts: Discovery={discovery_count}, Data={data_count}, ACK={ack_count}")
    
    # Show first N packets
    print(f"\nFirst {min(limit, len(packets))} packets:")
    for i, pkt in enumerate(packets[:limit]):
        bcudp = pkt['bcudp']
        direction = '→' if '192.168' in pkt['dst_ip'] else '←'
        pkt_type = bcudp['type'].upper()
        
        info = [f"#{pkt['frame_num']:4d}", f"{pkt['time']:8.3f}s", direction, pkt_type]
        
        if pkt_type == 'DATA':
            info.append(f"conn={bcudp.get('connection_id', '?')}")
            info.append(f"pid={bcudp.get('packet_id', '?')}")
            info.append(f"len={bcudp.get('payload_len', '?')}")
        elif pkt_type == 'ACK':
            info.append(f"conn={bcudp.get('connection_id', '?')}")
            info.append(f"pid={bcudp.get('packet_id', '?')}")
            info.append(f"gid={bcudp.get('group_id', '?')}")
        
        info.append(f"{pkt['src_port']}→{pkt['dst_port']}")
        
        print(' '.join(info))
        
        if i < 20:  # Show hex for first 20 packets
            if 'payload_hex' in bcudp:
                print(f"      Hex: {bcudp['payload_hex']}")

def compare_initial_sequence(neolink_packets: List[Dict[str, Any]], scrypted_packets: List[Dict[str, Any]]):
    """Compare the initial sequence after discovery."""
    print(f"\n{'='*100}")
    print("INITIAL SEQUENCE COMPARISON (first 50 packets after discovery)")
    print(f"{'='*100}")
    
    # Find first discovery completion (look for D2C_C_R response)
    nl_discovery_end = None
    for i, pkt in enumerate(neolink_packets):
        if pkt['bcudp']['type'] == 'discovery':
            # Check if it's a response (coming from camera)
            if '192.168' in pkt['src_ip']:  # From camera
                nl_discovery_end = i
                break
    
    sc_discovery_end = None
    for i, pkt in enumerate(scrypted_packets):
        if pkt['bcudp']['type'] == 'discovery':
            if '192.168' in pkt['src_ip']:  # From camera
                sc_discovery_end = i
                break
    
    print(f"\nDiscovery completed at:")
    print(f"  Neolink:  packet #{nl_discovery_end}" if nl_discovery_end else "  Neolink:  not found")
    print(f"  Scrypted: packet #{sc_discovery_end}" if sc_discovery_end else "  Scrypted: not found")
    
    # Get next 50 packets after discovery
    nl_next = neolink_packets[nl_discovery_end+1:nl_discovery_end+51] if nl_discovery_end else []
    sc_next = scrypted_packets[sc_discovery_end+1:sc_discovery_end+51] if sc_discovery_end else []
    
    print(f"\nNext 50 packets after discovery:")
    print(f"  Neolink:  {len(nl_next)} packets")
    print(f"  Scrypted: {len(sc_next)} packets")
    
    print(f"\nNeolink sequence:")
    for i, pkt in enumerate(nl_next[:30]):
        bcudp = pkt['bcudp']
        direction = '→' if '192.168' in pkt['dst_ip'] else '←'
        pkt_type = bcudp['type'].upper()
        time_rel = pkt['time'] - (neolink_packets[nl_discovery_end]['time'] if nl_discovery_end else 0)
        
        info = [f"{time_rel:6.3f}s", direction, pkt_type]
        if pkt_type == 'DATA':
            info.append(f"pid={bcudp.get('packet_id', '?')}")
        elif pkt_type == 'ACK':
            info.append(f"pid={bcudp.get('packet_id', '?')}")
        
        print(' '.join(info))
    
    print(f"\nScrypted sequence:")
    for i, pkt in enumerate(sc_next[:30]):
        bcudp = pkt['bcudp']
        direction = '→' if '192.168' in pkt['dst_ip'] else '←'
        pkt_type = bcudp['type'].upper()
        time_rel = pkt['time'] - (scrypted_packets[sc_discovery_end]['time'] if sc_discovery_end else 0)
        
        info = [f"{time_rel:6.3f}s", direction, pkt_type]
        if pkt_type == 'DATA':
            info.append(f"pid={bcudp.get('packet_id', '?')}")
        elif pkt_type == 'ACK':
            info.append(f"pid={bcudp.get('packet_id', '?')}")
        
        print(' '.join(info))

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 analyze_json.py <neolink.json> <scrypted.json>")
        sys.exit(1)
    
    neolink_file = sys.argv[1]
    scrypted_file = sys.argv[2]
    
    print("Loading neolink.json...")
    neolink_packets = extract_packets(neolink_file)
    
    print("Loading scrypted.json...")
    scrypted_packets = extract_packets(scrypted_file)
    
    print_flow_summary(neolink_packets, "NEOLINK", limit=50)
    print_flow_summary(scrypted_packets, "SCRYPTED", limit=50)
    compare_initial_sequence(neolink_packets, scrypted_packets)

if __name__ == '__main__':
    main()

