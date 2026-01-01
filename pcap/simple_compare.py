#!/usr/bin/env python3
"""
Simple script to find BCUDP packets in pcapng files by searching for magic numbers.
This doesn't parse the full pcapng format, just searches for BCUDP magic bytes.
"""
import sys
import struct

BCUDP_MAGIC_DISCOVERY = b'\x3a\xcf\x87\x2a'
BCUDP_MAGIC_DATA = b'\x10\xcf\x87\x2a'
BCUDP_MAGIC_ACK = b'\x20\xcf\x87\x2a'

def find_bcudp_packets(filename):
    """Find BCUDP packets by searching for magic numbers."""
    with open(filename, 'rb') as f:
        data = f.read()
    
    packets = []
    offset = 0
    
    while True:
        # Search for any BCUDP magic
        found_discovery = data.find(BCUDP_MAGIC_DISCOVERY, offset)
        found_data = data.find(BCUDP_MAGIC_DATA, offset)
        found_ack = data.find(BCUDP_MAGIC_ACK, offset)
        
        positions = []
        if found_discovery >= 0:
            positions.append((found_discovery, 'discovery'))
        if found_data >= 0:
            positions.append((found_data, 'data'))
        if found_ack >= 0:
            positions.append((found_ack, 'ack'))
        
        if not positions:
            break
        
        # Get the earliest position
        positions.sort()
        pos, pkt_type = positions[0]
        offset = pos + 4
        
        # Extract packet info
        if pkt_type == 'data' and len(data) >= pos + 20:
            connection_id = struct.unpack('<i', data[pos+4:pos+8])[0]
            packet_id = struct.unpack('<I', data[pos+12:pos+16])[0]
            payload_len = struct.unpack('<I', data[pos+16:pos+20])[0]
            hex_data = data[pos:pos+40].hex()
            packets.append({
                'type': 'data',
                'offset': pos,
                'connection_id': connection_id,
                'packet_id': packet_id,
                'payload_len': payload_len,
                'hex': hex_data
            })
        elif pkt_type == 'ack' and len(data) >= pos + 28:
            connection_id = struct.unpack('<i', data[pos+4:pos+8])[0]
            group_id = struct.unpack('<I', data[pos+12:pos+16])[0]
            packet_id = struct.unpack('<I', data[pos+16:pos+20])[0]
            hex_data = data[pos:pos+56].hex()
            packets.append({
                'type': 'ack',
                'offset': pos,
                'connection_id': connection_id,
                'group_id': group_id,
                'packet_id': packet_id,
                'hex': hex_data
            })
        elif pkt_type == 'discovery':
            hex_data = data[pos:pos+100].hex()
            packets.append({
                'type': 'discovery',
                'offset': pos,
                'hex': hex_data
            })
    
    return packets

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 simple_compare.py <neolink.pcapng> <scrypted.pcapng>")
        sys.exit(1)
    
    neolink_file = sys.argv[1]
    scrypted_file = sys.argv[2]
    
    print("Searching for BCUDP packets in neolink.pcapng...")
    neolink_packets = find_bcudp_packets(neolink_file)
    
    print("Searching for BCUDP packets in scrypted.pcapng...")
    scrypted_packets = find_bcudp_packets(scrypted_file)
    
    print(f"\n{'='*80}")
    print(f"NEOLINK: Found {len(neolink_packets)} BCUDP packets")
    print(f"{'='*80}")
    
    data_packets = [p for p in neolink_packets if p['type'] == 'data']
    ack_packets = [p for p in neolink_packets if p['type'] == 'ack']
    discovery_packets = [p for p in neolink_packets if p['type'] == 'discovery']
    
    print(f"  Discovery: {len(discovery_packets)}")
    print(f"  Data: {len(data_packets)}")
    print(f"  ACK: {len(ack_packets)}")
    
    if data_packets:
        print(f"\nFirst DATA packet:")
        first_data = data_packets[0]
        print(f"  conn={first_data['connection_id']}, pid={first_data['packet_id']}, len={first_data['payload_len']}")
        print(f"  Hex: {first_data['hex']}")
        if len(data_packets) > 1:
            print(f"\nSecond DATA packet:")
            second_data = data_packets[1]
            print(f"  conn={second_data['connection_id']}, pid={second_data['packet_id']}, len={second_data['payload_len']}")
            print(f"  Hex: {second_data['hex']}")
    
    if ack_packets:
        print(f"\nFirst ACK packet:")
        first_ack = ack_packets[0]
        print(f"  conn={first_ack['connection_id']}, pid={first_ack['packet_id']}, gid={first_ack['group_id']}")
        print(f"  Hex: {first_ack['hex']}")
    
    print(f"\n{'='*80}")
    print(f"SCRYPTED: Found {len(scrypted_packets)} BCUDP packets")
    print(f"{'='*80}")
    
    scrypted_data_packets = [p for p in scrypted_packets if p['type'] == 'data']
    scrypted_ack_packets = [p for p in scrypted_packets if p['type'] == 'ack']
    scrypted_discovery_packets = [p for p in scrypted_packets if p['type'] == 'discovery']
    
    print(f"  Discovery: {len(scrypted_discovery_packets)}")
    print(f"  Data: {len(scrypted_data_packets)}")
    print(f"  ACK: {len(scrypted_ack_packets)}")
    
    if scrypted_data_packets:
        print(f"\nFirst DATA packet:")
        first_data = scrypted_data_packets[0]
        print(f"  conn={first_data['connection_id']}, pid={first_data['packet_id']}, len={first_data['payload_len']}")
        print(f"  Hex: {first_data['hex']}")
        if len(scrypted_data_packets) > 1:
            print(f"\nSecond DATA packet:")
            second_data = scrypted_data_packets[1]
            print(f"  conn={second_data['connection_id']}, pid={second_data['packet_id']}, len={second_data['payload_len']}")
            print(f"  Hex: {second_data['hex']}")
    
    if scrypted_ack_packets:
        print(f"\nFirst ACK packet:")
        first_ack = scrypted_ack_packets[0]
        print(f"  conn={first_ack['connection_id']}, pid={first_ack['packet_id']}, gid={first_ack['group_id']}")
        print(f"  Hex: {first_ack['hex']}")
    
    # Compare first DATA packets
    print(f"\n{'='*80}")
    print("COMPARISON")
    print(f"{'='*80}")
    
    if data_packets and scrypted_data_packets:
        nl_first = data_packets[0]
        sc_first = scrypted_data_packets[0]
        print(f"\nFirst DATA packet comparison:")
        print(f"  Neolink:  conn={nl_first['connection_id']}, pid={nl_first['packet_id']}, len={nl_first['payload_len']}")
        print(f"  Scrypted: conn={sc_first['connection_id']}, pid={sc_first['packet_id']}, len={sc_first['payload_len']}")
        print(f"  Neolink hex:  {nl_first['hex']}")
        print(f"  Scrypted hex: {sc_first['hex']}")
        
        if nl_first['hex'] == sc_first['hex']:
            print(f"  ✓ Packets are IDENTICAL")
        else:
            print(f"  ⚠️  Packets are DIFFERENT")
            # Find first difference
            for i in range(0, min(len(nl_first['hex']), len(sc_first['hex'])), 2):
                if nl_first['hex'][i:i+2] != sc_first['hex'][i:i+2]:
                    print(f"  First difference at byte {i//2}: neolink={nl_first['hex'][i:i+2]}, scrypted={sc_first['hex'][i:i+2]}")
                    break

if __name__ == '__main__':
    main()

