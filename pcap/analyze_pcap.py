#!/usr/bin/env python3
"""Simple PCAP analyzer to compare neolink vs scrypted UDP flows"""
import sys
import struct

def read_pcap_header(f):
    """Read PCAP file header (24 bytes)"""
    magic = f.read(4)
    if magic != b'\xd4\xc3\xb2\xa1':  # pcap magic number (little endian)
        return None
    version_major, version_minor = struct.unpack('<HH', f.read(4))
    thiszone, sigfigs = struct.unpack('<II', f.read(8))
    snaplen, network = struct.unpack('<II', f.read(8))
    return {
        'version_major': version_major,
        'version_minor': version_minor,
        'snaplen': snaplen,
        'network': network
    }

def read_packet_header(f):
    """Read PCAP packet header (16 bytes)"""
    data = f.read(16)
    if len(data) < 16:
        return None
    ts_sec, ts_usec, incl_len, orig_len = struct.unpack('<IIII', data)
    return {
        'ts_sec': ts_sec,
        'ts_usec': ts_usec,
        'incl_len': incl_len,
        'orig_len': orig_len
    }

def analyze_pcap(filename):
    """Basic analysis of UDP packets in PCAP"""
    with open(filename, 'rb') as f:
        header = read_pcap_header(f)
        if not header:
            print(f"Error: {filename} is not a valid PCAP file")
            return
        
        packets = []
        packet_num = 0
        
        while True:
            pkt_header = read_packet_header(f)
            if not pkt_header:
                break
            
            packet_data = f.read(pkt_header['incl_len'])
            if len(packet_data) < pkt_header['incl_len']:
                break
            
            # Check if this is an Ethernet frame with IPv4 UDP
            if len(packet_data) >= 42:  # Min Ethernet + IP + UDP headers
                # Skip Ethernet header (14 bytes), check IP
                ip_header = packet_data[14:34]
                if ip_header[0] == 0x45:  # IPv4
                    protocol = ip_header[9]
                    if protocol == 17:  # UDP
                        src_port = struct.unpack('>H', ip_header[20:22])[0]
                        dst_port = struct.unpack('>H', ip_header[22:24])[0]
                        udp_data = packet_data[42:]
                        
                        # Check for BCUDP magic numbers
                        if len(udp_data) >= 4:
                            magic = udp_data[:4]
                            if magic == b'\x3a\xcf\x87\x2a':  # Discovery
                                packets.append({
                                    'num': packet_num,
                                    'ts': pkt_header['ts_sec'] + pkt_header['ts_usec'] / 1000000,
                                    'src_port': src_port,
                                    'dst_port': dst_port,
                                    'type': 'discovery',
                                    'data': udp_data[:100]  # First 100 bytes
                                })
                            elif magic == b'\x20\xcf\x87\x2a':  # ACK
                                packets.append({
                                    'num': packet_num,
                                    'ts': pkt_header['ts_sec'] + pkt_header['ts_usec'] / 1000000,
                                    'src_port': src_port,
                                    'dst_port': dst_port,
                                    'type': 'ack',
                                    'data': udp_data[:50]
                                })
                            elif magic == b'\x10\xcf\x87\x2a':  # DATA
                                packets.append({
                                    'num': packet_num,
                                    'ts': pkt_header['ts_sec'] + pkt_header['ts_usec'] / 1000000,
                                    'src_port': src_port,
                                    'dst_port': dst_port,
                                    'type': 'data',
                                    'data': udp_data[:50]
                                })
            
            packet_num += 1
        
        print(f"\n=== {filename} ===")
        print(f"Total packets analyzed: {packet_num}")
        print(f"BCUDP packets found: {len(packets)}")
        
        # Group by type
        by_type = {}
        for pkt in packets:
            by_type.setdefault(pkt['type'], []).append(pkt)
        
        for pkt_type, pkts in by_type.items():
            print(f"\n{pkt_type.upper()}: {len(pkts)} packets")
            if pkts:
                print(f"  First at {pkts[0]['ts']:.3f}s, last at {pkts[-1]['ts']:.3f}s")
                print(f"  Ports: src={set(p['src_port'] for p in pkts)}, dst={set(p['dst_port'] for p in pkts)}")
        
        # Show first few discovery packets in detail
        discovery_pkts = [p for p in packets if p['type'] == 'discovery']
        if discovery_pkts:
            print(f"\nFirst 5 discovery packets:")
            for pkt in discovery_pkts[:5]:
                print(f"  #{pkt['num']} at {pkt['ts']:.3f}s: {pkt['src_port']} -> {pkt['dst_port']}")
                # Look for XML-like content
                data_str = pkt['data'].decode('latin1', errors='ignore')
                if 'C2D' in data_str or 'D2C' in data_str:
                    # Try to extract XML tag
                    start = data_str.find('<')
                    if start >= 0:
                        end = data_str.find('>', start)
                        if end > start:
                            tag = data_str[start:end+1]
                            print(f"    Tag: {tag}")
        
        return packets

if __name__ == '__main__':
    neolink_packets = analyze_pcap('neolink.pcapng')
    print("\n" + "="*60)
    scrypted_packets = analyze_pcap('scrypted.pcapng')
