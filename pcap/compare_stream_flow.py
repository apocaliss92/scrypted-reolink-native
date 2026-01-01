#!/usr/bin/env python3
"""
Compare stream flow between neolink and scrypted after discovery/nonce request.
Focus on DATA/ACK packets to identify why stream might stall.
"""
import json
import sys
import struct

BCUDP_MAGIC_DATA = 0x10cf872a
BCUDP_MAGIC_ACK = 0x20cf872a

def hex_to_bytes(hex_str: str) -> bytes:
    try:
        return bytes.fromhex(hex_str.replace(':', '').replace(' ', ''))
    except:
        return b''

def parse_bcudp_data(data: bytes):
    """Parse BCUDP DATA packet."""
    if len(data) < 20:
        return None
    magic = struct.unpack('>I', data[0:4])[0]
    if magic != BCUDP_MAGIC_DATA:
        return None
    connection_id = int.from_bytes(data[4:8], 'little', signed=True)
    packet_id = int.from_bytes(data[12:16], 'little')
    payload_len = int.from_bytes(data[16:20], 'little')
    return {'type': 'data', 'connection_id': connection_id, 'packet_id': packet_id, 'payload_len': payload_len}

def parse_bcudp_ack(data: bytes):
    """Parse BCUDP ACK packet."""
    if len(data) < 28:
        return None
    magic = struct.unpack('>I', data[0:4])[0]
    if magic != BCUDP_MAGIC_ACK:
        return None
    connection_id = int.from_bytes(data[4:8], 'little', signed=True)
    group_id = int.from_bytes(data[12:16], 'little')
    packet_id = int.from_bytes(data[16:20], 'little')
    return {'type': 'ack', 'connection_id': connection_id, 'group_id': group_id, 'packet_id': packet_id}

def extract_stream_packets(json_file: str):
    """Extract DATA and ACK packets from stream."""
    packets = []
    
    with open(json_file, 'r') as f:
        data = json.load(f)
    
    for entry in data:
        source = entry.get('_source', {})
        layers = source.get('layers', {})
        frame = layers.get('frame', {})
        frame_num = int(frame.get('frame.number', '0'))
        frame_time = float(frame.get('frame.time_relative', '0'))
        udp = layers.get('udp', {})
        if not udp:
            continue
        src_port = int(udp.get('udp.srcport', '0'))
        dst_port = int(udp.get('udp.dstport', '0'))
        ip = layers.get('ip', {})
        src_ip = ip.get('ip.src', '')
        payload_hex = udp.get('udp.payload', '')
        if not payload_hex:
            continue
        
        bytes_data = hex_to_bytes(payload_hex)
        if len(bytes_data) < 4:
            continue
        
        # Try to parse as DATA or ACK
        pkt_data = parse_bcudp_data(bytes_data)
        if pkt_data:
            packets.append({
                'frame_num': frame_num,
                'time': frame_time,
                'src_ip': src_ip,
                'src_port': src_port,
                'dst_port': dst_port,
                **pkt_data
            })
            continue
        
        pkt_ack = parse_bcudp_ack(bytes_data)
        if pkt_ack:
            packets.append({
                'frame_num': frame_num,
                'time': frame_time,
                'src_ip': src_ip,
                'src_port': src_port,
                'dst_port': dst_port,
                **pkt_ack
            })
    
    return packets

def analyze_stream_flow(packets, name: str):
    """Analyze stream flow statistics."""
    print(f"\n{'='*100}")
    print(f"{name}: Stream Flow Analysis")
    print(f"{'='*100}")
    
    data_packets = [p for p in packets if p['type'] == 'data']
    ack_packets = [p for p in packets if p['type'] == 'ack']
    
    print(f"\nTotal packets: {len(packets)} (DATA: {len(data_packets)}, ACK: {len(ack_packets)})")
    
    if not data_packets:
        print("  No DATA packets found!")
        return
    
    # Find direction: camera->client (DATA) vs client->camera (ACK)
    # Assuming camera IP is 192.168.x.x
    camera_data = [p for p in data_packets if '192.168' in p['src_ip']]
    client_data = [p for p in data_packets if '192.168' not in p['src_ip']]
    
    camera_ack = [p for p in ack_packets if '192.168' in p['src_ip']]
    client_ack = [p for p in ack_packets if '192.168' not in p['src_ip']]
    
    print(f"\nDirection breakdown:")
    print(f"  Camera→Client DATA: {len(camera_data)}")
    print(f"  Client→Camera DATA: {len(client_data)}")
    print(f"  Camera→Client ACK:  {len(camera_ack)}")
    print(f"  Client→Camera ACK:  {len(client_ack)}")
    
    if camera_data:
        print(f"\nCamera→Client DATA packets:")
        print(f"  First: frame #{camera_data[0]['frame_num']}, time {camera_data[0]['time']:.3f}s, pid={camera_data[0]['packet_id']}")
        print(f"  Last:  frame #{camera_data[-1]['frame_num']}, time {camera_data[-1]['time']:.3f}s, pid={camera_data[-1]['packet_id']}")
        print(f"  Duration: {camera_data[-1]['time'] - camera_data[0]['time']:.3f}s")
        print(f"  Packet ID range: {camera_data[0]['packet_id']} → {camera_data[-1]['packet_id']}")
        
        # Check for gaps
        pids = sorted([p['packet_id'] for p in camera_data])
        gaps = []
        for i in range(len(pids) - 1):
            gap = pids[i+1] - pids[i]
            if gap > 1:
                gaps.append((pids[i], pids[i+1], gap))
        if gaps:
            print(f"  ⚠️  Found {len(gaps)} gaps in packet IDs:")
            for start, end, gap in gaps[:10]:
                print(f"     Missing: {start+1} to {end-1} (gap={gap-1})")
        else:
            print(f"  ✓ No gaps in packet IDs")
        
        # Check packet rate
        if len(camera_data) > 1:
            duration = camera_data[-1]['time'] - camera_data[0]['time']
            rate = len(camera_data) / duration if duration > 0 else 0
            print(f"  Packet rate: {rate:.2f} packets/sec")
    
    # Check ACK frequency from client
    if client_ack:
        print(f"\nClient→Camera ACK packets:")
        print(f"  Total: {len(client_ack)}")
        if len(client_ack) > 1:
            duration = client_ack[-1]['time'] - client_ack[0]['time']
            rate = len(client_ack) / duration if duration > 0 else 0
            print(f"  ACK rate: {rate:.2f} ACKs/sec")
            print(f"  First ACK: time {client_ack[0]['time']:.3f}s, pid={client_ack[0]['packet_id']}")
            print(f"  Last ACK:  time {client_ack[-1]['time']:.3f}s, pid={client_ack[-1]['packet_id']}")

def compare_streams(nl_packets, sc_packets):
    """Compare stream flows."""
    print(f"\n{'='*100}")
    print("COMPARISON")
    print(f"{'='*100}")
    
    nl_camera_data = [p for p in nl_packets if p['type'] == 'data' and '192.168' in p['src_ip']]
    sc_camera_data = [p for p in sc_packets if p['type'] == 'data' and '192.168' in p['src_ip']]
    
    nl_client_ack = [p for p in nl_packets if p['type'] == 'ack' and '192.168' not in p['src_ip']]
    sc_client_ack = [p for p in sc_packets if p['type'] == 'ack' and '192.168' not in p['src_ip']]
    
    print(f"\nCamera→Client DATA packets:")
    print(f"  Neolink:  {len(nl_camera_data)} packets")
    print(f"  Scrypted: {len(sc_camera_data)} packets")
    print(f"  Ratio:    {len(sc_camera_data) / len(nl_camera_data) * 100 if nl_camera_data else 0:.1f}%")
    
    print(f"\nClient→Camera ACK packets:")
    print(f"  Neolink:  {len(nl_client_ack)} packets")
    print(f"  Scrypted: {len(sc_client_ack)} packets")
    print(f"  Ratio:    {len(sc_client_ack) / len(nl_client_ack) * 100 if nl_client_ack else 0:.1f}%")
    
    if nl_camera_data and sc_camera_data:
        nl_duration = nl_camera_data[-1]['time'] - nl_camera_data[0]['time']
        sc_duration = sc_camera_data[-1]['time'] - sc_camera_data[0]['time']
        print(f"\nStream duration:")
        print(f"  Neolink:  {nl_duration:.2f}s")
        print(f"  Scrypted: {sc_duration:.2f}s")
        
        nl_rate = len(nl_camera_data) / nl_duration if nl_duration > 0 else 0
        sc_rate = len(sc_camera_data) / sc_duration if sc_duration > 0 else 0
        print(f"\nPacket rate:")
        print(f"  Neolink:  {nl_rate:.2f} packets/sec")
        print(f"  Scrypted: {sc_rate:.2f} packets/sec")
        
        if sc_rate < nl_rate * 0.5:
            print(f"  ⚠️  Scrypted has much lower packet rate!")

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 compare_stream_flow.py <neolink.json> <scrypted.json>")
        sys.exit(1)
    
    neolink_file = sys.argv[1]
    scrypted_file = sys.argv[2]
    
    print("Loading neolink.json...")
    nl_packets = extract_stream_packets(neolink_file)
    
    print("Loading scrypted.json...")
    sc_packets = extract_stream_packets(scrypted_file)
    
    analyze_stream_flow(nl_packets, "NEOLINK")
    analyze_stream_flow(sc_packets, "SCRYPTED")
    compare_streams(nl_packets, sc_packets)

if __name__ == '__main__':
    main()

