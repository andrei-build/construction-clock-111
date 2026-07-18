export type SherwinWilliamsColor = {
  code: string
  name: string
  hex: string
}

// Source: Sherwin-Williams downloadable ColorSnap color information spreadsheet.
const SW_COLOR_ROWS = `
SW0001|Mulberry Silk|#94766C
SW0002|Chelsea Mauve|#BEAC9F
SW0003|Cabbage Rose|#C59F91
SW0004|Rose Brocade|#996C6E
SW0005|Deepest Mauve|#6D595A
SW0006|Toile Red|#8B534E
SW0007|Decorous Amber|#AC7559
SW0008|Cajun Red|#8D422F
SW0009|Eastlake Gold|#C28E61
SW0010|Wickerwork|#C19E80
SW0011|Crewel Tan|#CBB99B
SW0012|Empire Gold|#C19F6E
SW0013|Majolica Green|#AEB08F
SW0014|Sheraton Sage|#8F8666
SW0015|Gallery Green|#708672
SW0016|Billiard Green|#45584D
SW0017|Calico|#8CA49C
SW0018|Teal Stencil|#627F7B
SW0019|Festoon Aqua|#A0BBB8
SW0020|Peacock Plume|#739694
SW0021|Queen Anne Lilac|#C0B6B4
SW0022|Patchwork Plum|#7E696A
SW0023|Pewter Tankard|#A39B90
SW0024|Curio Gray|#988977
SW0025|Rosedust|#CC8D84
SW0026|Rachel Pink|#E8B9AE
SW0027|Aristocrat Peach|#ECCEB9
SW0028|Caen Stone|#ECD0B1
SW0029|Acanthus|#CDCDB4
SW0030|Colonial Yellow|#EFC488
SW0031|Dutch Tile Blue|#9AABAB
SW0032|Needlepoint Navy|#546670
SW0033|Rembrandt Ruby|#974F49
SW0034|Roycroft Rose|#C08F80
SW0035|Warm Beige|#EEDAC3
SW0036|Buckram Binding|#D9C3A6
SW0037|Morris Room Grey|#ADA193
SW0038|Library Pewter|#7F7263
SW0039|Mellow Mauve|#C4957A
SW0040|Roycroft Adobe|#A76251
SW0041|Dard Hunter Green|#3A4A3F
SW0042|Ruskin Room Green|#ACA17D
SW0043|Peristyle Brass|#AE905E
SW0044|Hubbard Squash|#E9BF8C
SW0045|Antiquarian Brown|#946644
SW0046|White Hyacinth|#F3E5D1
SW0047|Studio Blue Green|#6D817B
SW0048|Bunglehouse Blue|#47626F
SW0049|Silver Gray|#B8B2A2
SW0050|Classic Light Buff|#F0EADC
SW0051|Classic Ivory|#F2E0C3
SW0052|Pearl Gray|#CBCEC5
SW0053|Porcelain|#E9E0D5
SW0054|Twilight Gray|#C8BFB5
SW0055|Light French Gray|#C2C0BB
SW0056|Classic Sand|#D6BCAA
SW0057|Chinese Red|#9E3E33
SW0058|Jazz Age Coral|#F1BFB1
SW0059|Frostwork|#CBD0C2
SW0060|Alexandrite|#598C74
SW0061|Salon Rose|#AB7878
SW0062|Studio Mauve|#C6B9B8
SW0063|Blue Sky|#ABD1C9
SW0064|Blue Peacock|#014E4C
SW0065|Vogue Green|#4B5645
SW0066|Cascade Green|#ACB19F
SW0067|Belvedere Cream|#F0CDA0
SW0068|Copen Blue|#C2CCC4
SW0069|Rose Tan|#CD9C85
SW0070|Pink Shadow|#DEC3B9
SW0071|Orchid|#BC9C9E
SW0072|Deep Maroon|#623F45
SW0073|Chartreuse|#E1D286
SW0074|Radiant Lilac|#A489A0
SW0075|Holiday Turquoise|#8AC6BD
SW0076|Appleblossom|#DAB5B4
SW0077|Classic French Gray|#888782
SW0078|Sunbeam Yellow|#F0D39D
SW0079|Pinky Beige|#C9AA98
SW0080|Pink Flamingo|#CD717B
SW1015|Skyline Steel|#C6BFB3
SW1666|Venetian Yellow|#F6E3A1
SW1667|Icy Lemonade|#F4E8B2
SW1668|Pineapple Cream|#F2EAC3
SW2704|Merlot|#51323B
SW2735|Rockweed|#443735
SW2739|Charcoal Blue|#3D4450
SW2740|Mineral Gray|#515763
SW2801|Rookwood Dark Red|#4B2929
SW2802|Rookwood Red|#622F2D
SW2803|Rookwood Terra Cotta|#975840
SW2804|Renwick Rose Beige|#AF8871
SW2805|Renwick Beige|#C3B09D
SW2806|Rookwood Brown|#7F614A
SW2807|Rookwood Medium Brown|#6E5241
SW2808|Rookwood Dark Brown|#5F4D43
SW2809|Rookwood Shutter Green|#303B39
SW2810|Rookwood Sash Green|#506A67
SW2811|Rookwood Blue Green|#738478
SW2812|Rookwood Jade|#979F7F
SW2813|Downing Straw|#CAAB7D
SW2814|Rookwood Antique Gold|#A58258
SW2815|Renwick Olive|#97896A
SW2816|Rookwood Dark Green|#565C4A
SW2817|Rookwood Amber|#C08650
SW2818|Renwick Heather|#8B7D7B
SW2819|Downing Slate|#777F86
SW2820|Downing Earth|#887B67
SW2821|Downing Stone|#A6A397
SW2822|Downing Sand|#CBBCA5
SW2823|Rookwood Clay|#9A7E64
SW2824|Renwick Golden Oak|#96724C
SW2826|Colonial Revival Green Stone|#A39B7E
SW2827|Colonial Revival Stone|#A7947C
SW2828|Colonial Revival Tan|#D3B699
SW2829|Classical White|#ECE1CB
SW2831|Classical Gold|#EBB875
SW2832|Colonial Revival Gray|#B4B9B9
SW2833|Roycroft Vellum|#E8D9BD
SW2834|Birdseye Maple|#E4C495
SW2835|Craftsman Brown|#AE9278
SW2836|Quartersawn Oak|#85695B
SW2837|Aurora Brown|#6A4238
SW2838|Polished Mahogany|#432722
SW2839|Roycroft Copper Red|#7B3728
SW2840|Hammered Silver|#978A7F
SW2841|Weathered Shingle|#937F68
SW2842|Roycroft Suede|#A79473
SW2843|Roycroft Brass|#7A6A51
SW2844|Roycroft Mist Gray|#C2BDB1
SW2845|Bunglehouse Gray|#988F7B
SW2846|Roycroft Bronze Green|#575449
SW2847|Roycroft Bottle Green|#324038
SW2848|Roycroft Pewter|#616564
SW2849|Westchester Gray|#797978
SW2850|Chelsea Gray|#B6B7B0
SW2851|Sage Green Light|#73705E
SW2853|New Colonial Yellow|#D9AD7F
SW2854|Caribbean Coral|#BE795E
SW2855|Sycamore Tan|#9C8A79
SW2856|Fairfax Brown|#61463A
SW2857|Peace Yellow|#EECF9E
SW2858|Harvest Gold|#D9A06A
SW2859|Beige|#DFC8B5
SW2860|Sage|#B3AE95
SW2861|Avocado|#857C5D
SW2863|Powder Blue|#89A4AD
SW2865|Classical Yellow|#F8D492
SW6000|Snowfall|#E0DEDA
SW6001|Grayish|#CFCAC7
SW6002|Essential Gray|#BCB8B6
SW6003|Proper Gray|#ADA8A5
SW6004|Mink|#847B77
SW6005|Folkstone|#6D6562
SW6006|Black Bean|#403330
SW6007|Smart White|#E4DBD8
SW6008|Individual White|#D4CDCA
SW6009|Imagine|#C2B6B6
SW6010|Flexible Gray|#B1A3A1
SW6011|Chinchilla|#867875
SW6012|Browse Brown|#6E615F
SW6013|Bitter Chocolate|#4D3C3C
SW6015|Vaguely Mauve|#D1C5C4
SW6016|Chaise Mauve|#C1B2B3
SW6017|Intuitive|#B3A3A5
SW6018|Enigma|#8B7C7E
SW6019|Poetry Plum|#6F5C5F
SW6020|Marooned|#4E3132
SW6021|Dreamy White|#E3D9D5
SW6022|Breathless|#D6C2BE
SW6023|Insightful Rose|#C9B0AB
SW6024|Dressy Rose|#B89D9A
SW6025|Socialite|#907676
SW6026|River Rouge|#76595D
SW6027|Cordovan|#5F3D3F
SW6028|Cultured Pearl|#E5DCD6
SW6029|White Truffle|#D7C8C2
SW6030|Artistic Taupe|#C3B1AC
SW6031|Glamour|#B6A09A
SW6032|Dutch Cocoa|#8C706A
SW6033|Bateau Brown|#7A5F5A
SW6034|Dark Auburn|#5A3532
SW6035|Gauzy White|#E3DBD4
SW6036|Angora|#D1C5BE
SW6037|Temperate Taupe|#BFB1AA
SW6038|Truly Taupe|#AC9E97
SW6039|Poised Taupe|#8C7E78
SW6040|Nutshell|#756761
SW6041|Otter|#56433B
SW6042|Hush White|#E5DAD4
SW6043|Unfussy Beige|#D6C8C0
SW6044|Doeskin|#C6B3A9
SW6045|Emerging Taupe|#B8A196
SW6046|Swing Brown|#947569
SW6047|Hot Cocoa|#806257
SW6048|Terra Brun|#5A382D
SW6049|Gorgeous White|#E7DBD3
SW6050|Abalone Shell|#DBC7BD
SW6051|Sashay Sand|#CFB4A8
SW6052|Sandbank|#C3A497
SW6053|Reddened Earth|#9C6E63
SW6054|Canyon Clay|#85594F
SW6055|Fiery Brown|#5D3831
SW6056|Polite White|#E9DDD4
SW6057|Malted Milk|#DECABD
SW6058|Likeable Sand|#D1B7A8
SW6059|Interface Tan|#C1A392
SW6060|Moroccan Spice|#9D7868
SW6061|Tanbark|#896656
SW6062|Vintage Leather|#694336
SW6063|Nice White|#E6DDD5
SW6064|Reticence|#D9CDC3
SW6065|Bona Fide Beige|#CBB9AB
SW6066|Sand Trap|#BBA595
SW6067|Mocha|#967A6A
SW6068|Brevity Brown|#715243
SW6069|French Roast|#4F3426
SW6070|Heron Plume|#E5E1D8
SW6071|Popular Gray|#D4CCC3
SW6072|Versatile Gray|#C1B6AB
SW6073|Perfect Greige|#B7AB9F
SW6074|Spalding Gray|#8D7F75
SW6075|Garret Gray|#756861
SW6076|Turkish Coffee|#4D3930
SW6077|Everyday White|#E4DCD4
SW6078|Realist Beige|#D3C8BD
SW6079|Diverse Beige|#C2B4A7
SW6080|Utterly Beige|#B5A597
SW6081|Down Home|#907865
SW6082|Cobble Brown|#7A6455
SW6083|Sable|#5F4B3F
SW6084|Modest White|#E6DDD4
SW6085|Simplify Beige|#D6C7B9
SW6086|Sand Dune|#C5B1A2
SW6087|Trusty Tan|#B59F8F
SW6088|Nuthatch|#8E725F
SW6089|Grounded|#785B47
SW6090|Java|#634533
SW6091|Reliable White|#E8DED3
`.trim()

export const SHERWIN_WILLIAMS_COLORS: SherwinWilliamsColor[] = SW_COLOR_ROWS.split('\n').map((row) => {
  const [code, name, hex] = row.split('|')
  return { code, name, hex }
})
