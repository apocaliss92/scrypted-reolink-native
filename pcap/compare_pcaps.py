#!/usr/bin/env python3
"""
Compare neolink.pcapng vs scrypted.pcapng to find differences in UDP flow.
This script parses pcapng files and extracts BCUDP packets for comparison.
"""
import struct
import sys
from typing import List, Dict, Any

BCUDP_MAGIC_DISCOVERY = 0x3acf872a
BCUDP_MAGIC_DATA = 0x10cf872a
BCUDP_MAGIC_ACK = 0x20cf872a

def read_pcapng_block(f) -> tuple[bytes, int] | None:
    """Read a pcapng block. Returns (block_type, block_data) or None if EOF."""
    # Read block type (4 bytes)
    block_type_data = f.read(4)
    if len(block_type_data) < 4:
        return None
    block_type = struct.unpack('<I', block_type_data)[0]
    
    # Read block length (4 bytes)
    block_length_data = f.read(4)
    if len(block_length_data) < 4:
        return None
    block_length = struct.unpack('<I', block_length_data)[0]
    
    if block_length < 12:  # Minimum block size (type + len + len)
        return None
    
    # Read block body (length - 8, since we already read type and length)
    block_body = f.read(block_length - 8)
    if len(block_body) < block_length - 8:
        return None
    
    # Read trailing length (should match)
    trailing_length_data = f.read(4)
    if len(trailing_length_data) < 4:
        return None
    trailing_length = struct.unpack('<I', trailing_length_data)[0]
    
    if trailing_length != block_length:
        print(f"Warning: block length mismatch: {block_length} != {trailing_length}")
    
    return (block_type, block_body)

def parse_enhanced_packet_block(block_body: bytes) -> Dict[str, Any] | None:
    """Parse an Enhanced Packet Block (type 6) from pcapng."""
    if len(block_body) < 16:
        return None
    
    # Read interface ID, timestamp, and packet data length
    interface_id = struct.unpack('<I', block_body[0:4])[0]
    timestamp_high = struct.unpack('<I', block_body[4:8])[0]
    timestamp_low = struct.unpack('<I', block_body[8:12])[0]
    captured_len = struct.unpack('<I', block_body[12:16])[0]
    
    # Packet data starts at offset 16
    packet_data = block_body[16:16+captured_len]
    
    return {
        'interface_id': interface_id,
        'timestamp': (timestamp_high << 32) | timestamp_low,
        'packet_data': packet_data
    }

def extract_udp_packet(packet_data: bytes) -> Dict[str, Any] | None:
    """Extract UDP packet from Ethernet frame. Returns None if not UDP."""
    # Skip Ethernet header (14 bytes)
    if len(packet_data) < 42:  # Min: 14 (Ethernet) + 20 (IP) + 8 (UDP)
        return None
    
    # Check for IPv4 (0x45 at offset 14)
    if packet_data[14] != 0x45:
        return None
    
    # Extract IP header fields
    ip_header = packet_data[14:34]
    src_ip = '.'.join(str(b) for b in ip_header[12:16])
    dst_ip = '.'.join(str(b) for b in ip_header[16:20])
    protocol = ip_header[9]
    
    if protocol != 17:  # UDP
        return None
    
    # Extract UDP header
    udp_header = packet_data[34:42]
    src_port = struct.unpack('>H', udp_header[0:2])[0]
    dst_port = struct.unpack('>H', udp_header[2:4])[0]
    udp_length = struct.unpack('>H', udp_header[4:6])[0]
    
    # UDP payload
    udp_payload = packet_data[42:42+udp_length-8]
    
    return {
        'src_ip': src_ip,
        'dst_ip': dst_ip,
        'src_port': src_port,
        'dst_port': dst_port,
        'payload': udp_payload
    }

def parse_bcudp_packet(udp_payload: bytes) -> Dict[str, Any] | None:
    """Parse BCUDP packet from UDP payload."""
    if len(udp_payload) < 4:
        return None
    
    magic = struct.unpack('<I', udp_payload[0:4])[0]
    
    if magic == BCUDP_MAGIC_DISCOVERY:
        return {
            'type': 'discovery',
            'magic': hex(magic),
            'payload': udp_payload
        }
    elif magic == BCUDP_MAGIC_DATA:
        if len(udp_payload) < 20:
            return None
        connection_id = struct.unpack('<i', udp_payload[4:8])[0]
        packet_id = struct.unpack('<I', udp_payload[12:16])[0]
        payload_len = struct.unpack('<I', udp_payload[16:20])[0]
        return {
            'type': 'data',
            'magic': hex(magic),
            'connection_id': connection_id,
            'packet_id': packet_id,
            'payload_len': payload_len,
            'payload': udp_payload
        }
    elif magic == BCUDP_MAGIC_ACK:
        if len(udp_payload) < 28:
            return None
        connection_id = struct.unpack('<i', udp_payload[4:8])[0]
        group_id = struct.unpack('<I', udp_payload[12:16])[0]
        packet_id = struct.unpack('<I', udp_payload[16:20])[0]
        return {
            'type': 'ack',
            'magic': hex(magic),
            'connection_id': connection_id,
            'group_id': group_id,
            'packet_id': packet_id,
            'payload': udp_payload
        }
    
    return None

def analyze_pcapng(filename: str) -> List[Dict[str, Any]]:
    """Analyze pcapng file and extract BCUDP packets."""
    packets = []
    
    with open(filename, 'rb') as f:
        # Read Section Header Block (first block, type 0x0A0D0D0A)
        first_block = read_pcapng_block(f)
        if not first_block or first_block[0] != 0x0A0D0D0A:
            print(f"Error: {filename} is not a valid pcapng file")
            return packets
        
        packet_num = 0
        while True:
            block = read_pcapng_block(f)
            if not block:
                break
            
            block_type, block_body = block
            
            # Enhanced Packet Block (type 6)
            if block_type == 6:
                epb = parse_enhanced_packet_block(block_body)
                if epb:
                    udp_pkt = extract_udp_packet(epb['packet_data'])
                    if udp_pkt:
                        bcudp_pkt = parse_bcudp_packet(udp_pkt['payload'])
                        if bcudp_pkt:
                            packets.append({
                                'num': packet_num,
                                'timestamp': epb['timestamp'],
                                'src_ip': udp_pkt['src_ip'],
                                'dst_ip': udp_pkt['dst_ip'],
                                'src_port': udp_pkt['src_port'],
                                'dst_port': udp_pkt['dst_port'],
                                'bcudp': bcudp_pkt,
                                'raw_payload': udp_pkt['payload'].hex()[:100]  # First 50 bytes hex
                            })
                            packet_num += 1
    
    return packets

def print_packet_summary(packets: List[Dict[str, Any]], name: str):
    """Print summary of packets."""
    print(f"\n{'='*80}")
    print(f"{name}: {len(packets)} BCUDP packets")
    print(f"{'='*80}")
    
    for i, pkt in enumerate(packets[:50]):  # Show first 50 packets
        bcudp = pkt['bcudp']
        direction = '→' if '192.168' in pkt['dst_ip'] else '←'
        pkt_type = bcudp['type'].upper()
        
        info_parts = [f"#{pkt['num']}", direction, pkt_type]
        
        if pkt_type == 'DATA':
            info_parts.append(f"conn={bcudp.get('connection_id', '?')}")
            info_parts.append(f"pid={bcudp.get('packet_id', '?')}")
            info_parts.append(f"len={bcudp.get('payload_len', '?')}")
        elif pkt_type == 'ACK':
            info_parts.append(f"conn={bcudp.get('connection_id', '?')}")
            info_parts.append(f"pid={bcudp.get('packet_id', '?')}")
            info_parts.append(f"gid={bcudp.get('group_id', '?')}")
        
        info_parts.append(f"{pkt['src_port']}→{pkt['dst_port']}")
        
        print(f"{' '.join(info_parts)}")
        if i < 10:  # Show hex for first 10 packets
            print(f"  Hex: {pkt['raw_payload']}...")
    
    if len(packets) > 50:
        print(f"... and {len(packets) - 50} more packets")

def compare_flows(neolink_packets: List[Dict[str, Any]], scrypted_packets: List[Dict[str, Any]]):
    """Compare the two flows and highlight differences."""
    print(f"\n{'='*80}")
    print("COMPARISON")
    print(f"{'='*80}")
    
    print(f"\nNeolink: {len(neolink_packets)} BCUDP packets")
    print(f"Scrypted: {len(scrypted_packets)} BCUDP packets")
    
    # Find first DATA packets
    neolink_first_data = next((p for p in neolink_packets if p['bcudp']['type'] == 'data'), None)
    scrypted_first_data = next((p for p in scrypted_packets if p['bcudp']['type'] == 'data'), None)
    
    if neolink_first_data and scrypted_first_data:
        print(f"\nFirst DATA packet:")
        print(f"  Neolink:  conn={neolink_first_data['bcudp'].get('connection_id')}, pid={neolink_first_data['bcudp'].get('packet_id')}, {neolink_first_data['src_port']}→{neolink_first_data['dst_port']}")
        print(f"  Scrypted: conn={scrypted_first_data['bcudp'].get('connection_id')}, pid={scrypted_first_data['bcudp'].get('packet_id')}, {scrypted_first_data['src_port']}→{scrypted_first_data['dst_port']}")
        print(f"  Hex Neolink:  {neolink_first_data['raw_payload']}")
        print(f"  Hex Scrypted: {scrypted_first_data['raw_payload']}")
        
        if neolink_first_data['raw_payload'] != scrypted_first_data['raw_payload']:
            print(f"  ⚠️  DIFFERENT HEX!")
        else:
            print(f"  ✓ Same hex")
    
    # Count DATA/ACK packets after discovery
    neolink_data_count = sum(1 for p in neolink_packets if p['bcudp']['type'] == 'data')
    neolink_ack_count = sum(1 for p in neolink_packets if p['bcudp']['type'] == 'ack')
    scrypted_data_count = sum(1 for p in scrypted_packets if p['bcudp']['type'] == 'data')
    scrypted_ack_count = sum(1 for p in scrypted_packets if p['bcudp']['type'] == 'ack')
    
    print(f"\nPacket counts:")
    print(f"  Neolink:  {neolink_data_count} DATA, {neolink_ack_count} ACK")
    print(f"  Scrypted: {scrypted_data_count} DATA, {scrypted_ack_count} ACK")

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 compare_pcaps.py <neolink.pcapng> <scrypted.pcapng>")
        sys.exit(1)
    
    neolink_file = sys.argv[1]
    scrypted_file = sys.argv[2]
    
    print("Analyzing neolink.pcapng...")
    neolink_packets = analyze_pcapng(neolink_file)
    
    print("Analyzing scrypted.pcapng...")
    scrypted_packets = analyze_pcapng(scrypted_file)
    
    print_packet_summary(neolink_packets, "NEOLINK")
    print_packet_summary(scrypted_packets, "SCRYPTED")
    compare_flows(neolink_packets, scrypted_packets)

if __name__ == '__main__':
    main()

